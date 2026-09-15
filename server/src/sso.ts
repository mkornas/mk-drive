/**
 * "Sign in with <name>": /auth/login sends the browser to the OpenID provider,
 * /auth/callback maps the verified email to a local account and opens the
 * usual session. Unknown or disabled accounts are refused — the provider says
 * who you are, the admin says whether you belong here. Refusals and failures
 * land on /login?reason=… .
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createOidc, type MkIdentity, type Oidc, registerOidcRoutes } from '@mk-kit/auth/server';
import type { Config } from './config.ts';
import { clientIp, isSecure, setSessionCookie } from './auth.ts';
import type { Settings } from './settings.ts';
import type { Users } from './users.ts';

/** One provider: what the button says, where it lives, and the client the drive is registered as there. */
export interface SsoConf {
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export const DEFAULT_SSO_NAME = 'Single sign-on';
/** Where an admin's choice is kept in the settings table. */
export const SSO_KEYS = { issuer: 'sso.issuer', clientId: 'sso.clientId', clientSecret: 'sso.clientSecret', name: 'sso.name' } as const;

/**
 * The provider in force: DRIVE_OIDC_* when the environment sets all three (a deployment that configures itself keeps
 * doing so, and the Settings page shows it read-only), else what an admin saved on the Sign-in page, else none.
 * A confidential client cannot finish the flow without its secret: issuer, client ID and secret are all required.
 */
export function resolveSso(cfg: Config, settings: Settings | null): { source: 'env' | 'settings'; conf: SsoConf } | null {
  if (cfg.oidcIssuer && cfg.oidcClientId && cfg.oidcClientSecret)
    return {
      source: 'env',
      conf: { name: cfg.oidcName || DEFAULT_SSO_NAME, issuer: cfg.oidcIssuer, clientId: cfg.oidcClientId, clientSecret: cfg.oidcClientSecret },
    };
  const get = (k: string) => settings?.get(k) ?? '';
  const conf = {
    name: get(SSO_KEYS.name) || DEFAULT_SSO_NAME,
    issuer: get(SSO_KEYS.issuer),
    clientId: get(SSO_KEYS.clientId),
    clientSecret: get(SSO_KEYS.clientSecret),
  };
  return conf.issuer && conf.clientId && conf.clientSecret ? { source: 'settings', conf } : null;
}

export function ssoEnabled(cfg: Config, settings: Settings | null = null): boolean {
  return resolveSso(cfg, settings) !== null;
}

/** Reads the provider's discovery document with these values: what the Settings page checks before it saves anything. */
export function discover(conf: SsoConf): Promise<Oidc> {
  return createOidc({
    issuer: conf.issuer,
    clientId: conf.clientId,
    clientSecret: conf.clientSecret || undefined,
    allowInsecure: conf.issuer.startsWith('http://'),
  });
}

/** The origin the browser is on — what the provider must send it back to. */
export function origin(req: FastifyRequest): string {
  return `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
}

function toLogin(reply: FastifyReply, reason: string): FastifyReply {
  return reply.header('Cache-Control', 'no-store').redirect(`/login?reason=${encodeURIComponent(reason)}`, 303);
}

interface SsoLog {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * The provider, discovered lazily: once at start and again on every login
 * attempt until it answers. The drive usually boots alongside the provider
 * (same box, same power cycle), so an issuer that is not up yet must not turn
 * into "no single sign-on until someone restarts the drive". The settings are
 * read on every use, so a change on the Settings page takes effect without a
 * restart.
 */
export class SsoProvider {
  private readonly current: () => SsoConf | null;
  private readonly log: SsoLog;
  private client: Oidc | null = null;
  /** The settings the client was discovered with; a different set discards it. */
  private clientFor = '';
  private pending: Promise<Oidc | null> | null = null;
  /** Why the last discovery failed, for the Settings page; null after a success. */
  lastError: string | null = null;

  constructor(current: () => SsoConf | null, log: SsoLog) {
    this.current = current;
    this.log = log;
  }

  get conf(): SsoConf | null {
    return this.current();
  }

  get ready(): boolean {
    const conf = this.current();
    return conf !== null && this.client !== null && this.clientFor === keyOf(conf);
  }

  get issuer(): string {
    return this.client?.issuer ?? this.current()?.issuer ?? '';
  }

  /** The discovered client, or null while none is set up or the issuer cannot be reached (one attempt at a time; each failure is logged). */
  connect(): Promise<Oidc | null> {
    const conf = this.current();
    if (!conf) {
      this.client = null;
      return Promise.resolve(null);
    }
    const key = keyOf(conf);
    if (this.client && this.clientFor === key) return Promise.resolve(this.client);
    this.pending ??= discover(conf)
      .then(
        (client) => {
          this.client = client;
          this.clientFor = key;
          this.lastError = null;
          this.log.info(`single sign-on: ${conf.name} via ${client.issuer}`);
          return client;
        },
        (e: Error) => {
          this.client = null;
          this.lastError = e.message;
          this.log.error(`single sign-on: could not read ${conf.issuer}/.well-known/openid-configuration (${e.message}); retried on the next login`);
          return null;
        },
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** A client discovered already (the Settings page checked it) replaces the old one at once. */
  use(conf: SsoConf, client: Oidc | null): void {
    this.client = client;
    this.clientFor = client ? keyOf(conf) : '';
    this.lastError = null;
  }

  // The surface registerOidcRoutes() calls. The routes only run once connect() has succeeded (see registerSso).
  authorize(redirectUri: string): ReturnType<Oidc['authorize']> {
    return this.require().authorize(redirectUri);
  }

  callback(url: URL, expected: { state: string; nonce: string; codeVerifier: string }): Promise<MkIdentity> {
    return this.require().callback(url, expected);
  }

  /** The provider's logout page (RP-initiated logout) when it offers one and is connected, else null. */
  endSessionUrl(postLogoutRedirectUri?: string, idTokenHint?: string): string | null {
    return this.client?.endSessionUrl(postLogoutRedirectUri, idTokenHint) ?? null;
  }

  private require(): Oidc {
    if (!this.ready) throw new Error(`${this.current()?.issuer || 'the provider'} is not reachable`);
    return this.client!;
  }
}

const keyOf = (c: SsoConf) => JSON.stringify([c.issuer, c.clientId, c.clientSecret]);

/** Registers `/auth/login` and `/auth/callback`; they refuse politely while no provider is set up. */
export function registerSso(app: FastifyInstance, cfg: Config, users: Users, sso: SsoProvider): void {
  // a login attempt while the provider is still unreachable retries the discovery, and explains itself when that fails too
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path !== '/auth/login' && path !== '/auth/callback') return;
    const conf = sso.conf;
    if (!conf) return toLogin(reply, 'single sign-on is not set up on this drive');
    if (path === '/auth/callback') {
      await sso.connect(); // after a restart mid-login; a failure shows up as the callback's own error
      return;
    }
    if (await sso.connect()) return;
    return toLogin(reply, `sign-in with ${conf.name} is unavailable: ${conf.issuer} could not be reached — try again in a moment`);
  });

  registerOidcRoutes<FastifyRequest, FastifyReply>(app, {
    // SsoProvider offers everything the routes call; Oidc's private fields make its type nominal, hence the cast
    oidc: sso as unknown as Oidc,
    /** Signs the ten-minute login cookie only; random per start when unset (a restart mid-login just restarts the login). */
    cookieSecret: cfg.cookieSecret || randomBytes(32).toString('base64url'),
    redirectUri: (req) => `${origin(req)}/auth/callback`,
    cookie: { secure: isSecure },
    onSignedIn: async (identity, { req, reply, next }) => {
      const user = identity.email ? users.byEmail(identity.email) : null;
      if (!user || user.disabled) {
        users.audit({ userId: null, email: identity.email || '?', action: 'login.failed', detail: `sso: ${user ? 'disabled' : 'no account'}` });
        return toLogin(reply, user ? 'this account is disabled' : `no account for ${identity.email || 'that identity'} — ask the admin to add you`);
      }
      const session = users.createSession(user.id, cfg.sessionDays * 86_400_000, {
        userAgent: req.headers['user-agent'],
        ip: clientIp(req, cfg.trustedProxies),
        via: 'sso',
        idToken: identity.idToken,
      });
      users.markLogin(user.id);
      setSessionCookie(req, reply, session.id, cfg.sessionDays * 86_400);
      users.audit({ userId: user.id, email: user.email, action: 'login', detail: `sso (${identity.issuer})` });
      return reply.redirect(next, 303);
    },
    onError: async (error, { reply }) => toLogin(reply, `sign-in failed: ${error.message}`),
  });
}
