/**
 * Settings → Sign-in: an admin points the drive at their own OpenID Connect
 * provider. Nothing about any particular provider ships with the drive. The
 * values are checked against the provider's discovery document before they
 * are saved, the secret is written but never read back, and DRIVE_OIDC_* in
 * the environment, when set, stays in charge and shows read-only. Where
 * password sign-in works (everywhere, the local network only, nowhere) is
 * chosen here too, unless DRIVE_PASSWORD_LOGIN sets it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PasswordLoginInput, SsoSettings, SsoSettingsInput } from '../../../shared/types.ts';
import { PASSWORD_LOGIN_KEY, resolvePasswordLogin } from '../auth.ts';
import type { Config } from '../config.ts';
import { badRequest, forbidden, HttpError } from '../errors.ts';
import type { Settings } from '../settings.ts';
import { DEFAULT_SSO_NAME, discover, origin, resolveSso, SSO_KEYS, type SsoConf, type SsoProvider } from '../sso.ts';
import type { Users } from '../users.ts';
import { sessionOnly } from './app-passwords.ts';

const text = (v: unknown, what: string, max: number): string => {
  if (v !== undefined && typeof v !== 'string') throw badRequest(`${what} must be text`);
  const s = (v ?? '').trim();
  if (s.length > max) throw badRequest(`${what} must be ${max} characters or fewer`);
  return s;
};

export function issuerUrl(v: unknown): string {
  const raw = text(v, 'the issuer', 500).replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('the issuer must be a URL, like https://id.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('the issuer must start with https://');
  if (u.search || u.hash || u.username || u.password) throw badRequest('the issuer is the provider’s base URL: no query, fragment or credentials');
  return raw;
}

export function registerSsoSettingsRoutes(app: FastifyInstance, cfg: Config, users: Users, settings: Settings, sso: SsoProvider): void {
  const admin = (req: FastifyRequest) => {
    if (req.identity?.role !== 'admin') throw forbidden('admins only');
    sessionOnly(req);
  };

  const view = (req: FastifyRequest): SsoSettings => {
    const r = resolveSso(cfg, settings);
    const saved = (k: string) => settings.get(k) ?? '';
    const shown = r?.conf ?? {
      name: saved(SSO_KEYS.name) || DEFAULT_SSO_NAME,
      issuer: saved(SSO_KEYS.issuer),
      clientId: saved(SSO_KEYS.clientId),
      clientSecret: saved(SSO_KEYS.clientSecret),
    };
    const pw = resolvePasswordLogin(cfg, settings);
    return {
      source: r?.source ?? null,
      name: shown.name,
      issuer: shown.issuer,
      clientId: shown.clientId,
      hasSecret: !!shown.clientSecret,
      ready: sso.ready,
      error: r ? sso.lastError : null,
      redirectUri: `${origin(req)}/auth/callback`,
      logoutRedirectUri: `${origin(req)}/login`,
      passwordLoginOff: pw.mode === 'off',
      passwordLogin: pw.mode,
      passwordLoginSource: pw.source,
    };
  };

  const fromEnv = () => {
    if (resolveSso(cfg, null))
      throw new HttpError(409, 'single sign-on is set in the environment (DRIVE_OIDC_*); change it there, or remove those lines to set it here');
  };

  app.get('/api/settings/sso', async (req): Promise<SsoSettings> => {
    admin(req);
    // a provider that was down at start is asked again when an admin looks
    if (sso.conf && !sso.ready) await sso.connect();
    return view(req);
  });

  app.put<{ Body: SsoSettingsInput }>('/api/settings/sso', async (req): Promise<SsoSettings> => {
    admin(req);
    fromEnv();
    const b = (req.body ?? {}) as unknown as Record<string, unknown>;
    const conf: SsoConf = {
      name: text(b.name, 'the name', 40) || DEFAULT_SSO_NAME,
      issuer: issuerUrl(b.issuer),
      clientId: text(b.clientId, 'the client ID', 200),
      clientSecret: text(b.clientSecret, 'the client secret', 500) || (settings.get(SSO_KEYS.clientSecret) ?? ''),
    };
    if (!conf.clientId) throw badRequest('the client ID is missing');
    if (!conf.clientSecret) throw badRequest('the client secret is missing');
    // nothing is saved that the provider does not answer to
    let client;
    try {
      client = await discover(conf);
    } catch (e) {
      throw badRequest(`${conf.issuer}/.well-known/openid-configuration could not be read: ${(e as Error).message}`);
    }
    settings.set(SSO_KEYS.name, conf.name === DEFAULT_SSO_NAME ? null : conf.name);
    settings.set(SSO_KEYS.issuer, conf.issuer);
    settings.set(SSO_KEYS.clientId, conf.clientId);
    settings.set(SSO_KEYS.clientSecret, conf.clientSecret);
    sso.use(conf, client);
    users.audit({
      userId: req.identity.id,
      email: req.identity.email,
      action: 'settings.sso',
      detail: { name: conf.name, issuer: conf.issuer, clientId: conf.clientId, secret: b.clientSecret ? 'changed' : 'kept' },
    });
    return view(req);
  });

  app.delete('/api/settings/sso', async (req): Promise<SsoSettings> => {
    admin(req);
    fromEnv();
    // with password sign-in off, single sign-on is the only way in: turning it off would lock everyone out
    const pw = resolvePasswordLogin(cfg, settings);
    if (pw.mode === 'off')
      throw badRequest(
        `password sign-in is off on this drive${pw.source === 'env' ? ' (DRIVE_PASSWORD_LOGIN=off)' : ''}, so single sign-on is the only way in; it stays on`,
      );
    for (const k of Object.values(SSO_KEYS)) settings.set(k, null);
    sso.use({ name: '', issuer: '', clientId: '', clientSecret: '' }, null);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'settings.sso', detail: { off: true } });
    return view(req);
  });

  app.put<{ Body: PasswordLoginInput }>('/api/settings/password-login', async (req): Promise<SsoSettings> => {
    admin(req);
    if (resolvePasswordLogin(cfg, null).source === 'env')
      throw new HttpError(409, 'password sign-in is set in the environment (DRIVE_PASSWORD_LOGIN); change it there, or remove that line to choose it here');
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'on' && mode !== 'local' && mode !== 'off') throw badRequest('mode must be on, local or off');
    // `local` always leaves a way in (from home); `off` only when single sign-on can take over
    if (mode === 'off' && !resolveSso(cfg, settings))
      throw badRequest('turn on single sign-on first: with password sign-in off and no single sign-on, nobody could sign in');
    settings.set(PASSWORD_LOGIN_KEY, mode === 'on' ? null : mode);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'settings.password-login', detail: { mode } });
    return view(req);
  });
}
