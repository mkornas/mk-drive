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
import type { Users } from './users.ts';

export function ssoEnabled(cfg: Config): boolean {
  // a confidential client cannot finish the flow without its secret: all three enable it
  return !!(cfg.oidcIssuer && cfg.oidcClientId && cfg.oidcClientSecret);
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
 * into "no single sign-on until someone restarts the drive".
 */
export class SsoProvider {
  private readonly cfg: Config;
  private readonly log: SsoLog;
  private client: Oidc | null = null;
  private pending: Promise<Oidc | null> | null = null;

  constructor(cfg: Config, log: SsoLog) {
    this.cfg = cfg;
    this.log = log;
  }

  get ready(): boolean {
    return this.client !== null;
  }

  get issuer(): string {
    return this.client?.issuer ?? this.cfg.oidcIssuer;
  }

  /** The discovered client, or null while the issuer cannot be reached (one attempt at a time; each failure is logged). */
  connect(): Promise<Oidc | null> {
    if (this.client) return Promise.resolve(this.client);
    this.pending ??= createOidc({ issuer: this.cfg.oidcIssuer, clientId: this.cfg.oidcClientId, clientSecret: this.cfg.oidcClientSecret || undefined, allowInsecure: this.cfg.oidcIssuer.startsWith('http://') })
      .then(
        (client) => {
          this.client = client;
          this.log.info(`single sign-on: ${this.cfg.oidcName} via ${client.issuer}`);
          return client;
        },
        (e: Error) => {
          this.log.error(`single sign-on: could not read ${this.cfg.oidcIssuer}/.well-known/openid-configuration (${e.message}); retried on the next login`);
          return null;
        },
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
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
    if (!this.client) throw new Error(`${this.cfg.oidcIssuer} is not reachable`);
    return this.client;
  }
}

/** Registers `/auth/login` and `/auth/callback`. */
export function registerSso(app: FastifyInstance, cfg: Config, users: Users, sso: SsoProvider): void {
  // a login attempt while the provider is still unreachable retries the discovery, and explains itself when that fails too
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] !== '/auth/login' || (await sso.connect())) return;
    return toLogin(reply, `sign-in with ${cfg.oidcName} is unavailable: ${cfg.oidcIssuer} could not be reached — try again in a moment`);
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
      const session = users.createSession(user.id, cfg.sessionDays * 86_400_000, { userAgent: req.headers['user-agent'], ip: clientIp(req, cfg.trustedProxies), via: 'sso', idToken: identity.idToken });
      users.markLogin(user.id);
      setSessionCookie(req, reply, session.id, cfg.sessionDays * 86_400);
      users.audit({ userId: user.id, email: user.email, action: 'login', detail: `sso (${identity.issuer})` });
      return reply.redirect(next, 303);
    },
    onError: async (error, { reply }) => toLogin(reply, `sign-in failed: ${error.message}`),
  });
}
