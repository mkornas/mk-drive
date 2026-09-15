import { NAS_CONTRACT, type NasClient } from '../nas.ts';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import { type Auth, clearSessionCookie, clientIp, passwordLoginAllowed, setSessionCookie } from '../auth.ts';
import { PASSWORD_MIN, verifyPassword, type Users } from '../users.ts';
import { badRequest, forbidden, HttpError } from '../errors.ts';
import { sessionOnly } from './app-passwords.ts';
import type { Health, Identity, Meta, Session, SignOutResult } from '../../../shared/types.ts';
import { origin, type SsoProvider } from '../sso.ts';
import type { Settings } from '../settings.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) throw badRequest(`password must be at least ${PASSWORD_MIN} characters`);
  if (pw.length > 200) throw badRequest('password too long');
  return pw;
}

function checkEmail(email: unknown): string {
  if (typeof email !== 'string' || !EMAIL.test(email.trim()) || email.length > 200) throw badRequest('a valid email is required');
  return email.trim();
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw badRequest('a name is required');
  return name.trim();
}

/** Setup, login, sessions and the account of the signed-in user. */
export function registerAccountRoutes(
  app: FastifyInstance,
  cfg: Config,
  auth: Auth,
  users: Users,
  sso: SsoProvider | null,
  nas: NasClient | null = null,
  settings: Settings | null = null,
): void {
  const ttlMs = cfg.sessionDays * 86_400_000;

  app.get('/api/health', async (): Promise<Health> => ({ ok: true, build: cfg.build, version: cfg.version, uptime: Math.round(process.uptime()) }));

  /** In NAS mode: the agent's version against the contract this drive needs, asked at most once a minute. */
  const outdated = async (): Promise<Meta['nasOutdated']> => {
    if (!nas) return undefined;
    const v = await nas.cachedVersion();
    return v && v.contract < NAS_CONTRACT ? { agent: v.agent, contract: v.contract, needs: NAS_CONTRACT } : undefined;
  };

  app.get('/api/meta', async (req): Promise<Meta> => ({
    app: cfg.app,
    version: cfg.version,
    build: cfg.build,
    name: settings?.get('name') ?? undefined,
    me: req.identity ?? null,
    setupRequired: users.count() === 0,
    reason: req.identity ? undefined : req.authReason,
    demo: cfg.demo || undefined,
    sso: sso?.conf ? { name: sso.conf.name } : undefined,
    passwordLogin: passwordLoginAllowed(req, cfg),
    nas: cfg.nasSocket ? true : undefined,
    nasOutdated: await outdated(),
  }));

  app.get('/api/me', async (req): Promise<Identity> => req.identity);

  /** The drive's name in the header; admins only, an empty name puts the default back. */
  app.put<{ Body: { name?: unknown } }>('/api/settings/name', async (req): Promise<{ name: string | null }> => {
    if (req.identity?.role !== 'admin') throw forbidden('admins only');
    sessionOnly(req);
    if (!settings) throw forbidden('not available');
    const raw = req.body?.name;
    if (typeof raw !== 'string') throw badRequest('send { name }');
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name.length > 40) throw badRequest('the name must be 40 characters or fewer');
    settings.set('name', name || null);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'drive.rename', detail: { name: name || null } });
    return { name: name || null };
  });

  app.post<{ Body: { email?: unknown; name?: unknown; password?: unknown } }>('/api/setup', async (req, reply): Promise<Identity> => {
    if (users.count() > 0) throw forbidden('setup is already done');
    const email = checkEmail(req.body?.email);
    const name = checkName(req.body?.name);
    const password = checkPassword(req.body?.password);
    const user = await users.create({ email, name, role: 'admin', password });
    users.markLogin(user.id);
    users.audit({ userId: user.id, email: user.email, action: 'setup', detail: 'first admin created' });
    const session = users.createSession(user.id, ttlMs, { userAgent: req.headers['user-agent'], ip: clientIp(req, cfg.trustedProxies) });
    setSessionCookie(req, reply, session.id, cfg.sessionDays * 86_400);
    return { id: user.id, email: user.email, name: user.name, role: user.role, via: 'session', sessionId: session.id };
  });

  app.post<{ Body: { email?: unknown; password?: unknown } }>('/api/login', async (req, reply): Promise<Identity> => {
    if (!passwordLoginAllowed(req, cfg)) throw forbidden('password sign-in is not available from here');
    const ip = clientIp(req, cfg.trustedProxies);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const wait = Math.max(auth.throttle.retryAfter(ip), email ? auth.throttle.retryAfter(`email:${email}`) : 0);
    if (wait > 0) {
      reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(429, `too many attempts, wait ${Math.ceil(wait / 1000)} s`);
    }
    const user = email && password ? await users.authenticate(email, password) : null;
    if (!user) {
      auth.throttle.failed(ip);
      if (email) auth.throttle.failed(`email:${email}`);
      users.audit({ userId: null, email: email || '?', action: 'login.failed', detail: ip });
      throw new HttpError(401, 'wrong email or password');
    }
    auth.throttle.succeeded(ip);
    auth.throttle.succeeded(`email:${email}`);
    const session = users.createSession(user.id, ttlMs, { userAgent: req.headers['user-agent'], ip });
    setSessionCookie(req, reply, session.id, cfg.sessionDays * 86_400);
    users.audit({ userId: user.id, email: user.email, action: 'login', detail: ip });
    return { id: user.id, email: user.email, name: user.name, role: user.role, via: 'session', sessionId: session.id };
  });

  app.post('/api/logout', async (req, reply): Promise<SignOutResult> => {
    sessionOnly(req);
    const sid = req.identity?.sessionId;
    const began = sid ? users.sessionOrigin(sid) : null;
    if (sid) users.deleteSession(sid);
    clearSessionCookie(req, reply);
    // a session the provider opened is closed there too (RP-initiated logout); the ID token tells the provider whose, so it comes straight back
    const redirect = began?.via === 'sso' ? sso?.endSessionUrl(`${origin(req)}/login`, began.idToken ?? undefined) : null;
    return { ok: true, redirect: redirect ?? undefined };
  });

  app.get('/api/sessions', async (req): Promise<Session[]> => {
    sessionOnly(req);
    return users.sessionsOf(req.identity.id, req.identity.sessionId);
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    sessionOnly(req);
    const mine = users.sessionsOf(req.identity.id).find((s) => s.id === req.params.id);
    if (!mine) throw badRequest('not your session');
    users.deleteSession(req.params.id);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'session.revoke' });
    return { ok: true };
  });

  app.post('/api/sessions/revoke-others', async (req) => {
    sessionOnly(req);
    users.deleteOtherSessions(req.identity.id, req.identity.sessionId);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'session.revoke-others' });
    return { ok: true };
  });

  app.patch<{ Body: { name?: unknown } }>('/api/account', async (req): Promise<Identity> => {
    sessionOnly(req);
    const name = checkName(req.body?.name);
    users.update(req.identity.id, { name });
    return { ...req.identity, name };
  });

  app.post<{ Body: { current?: unknown; password?: unknown } }>('/api/account/password', async (req) => {
    sessionOnly(req);
    const user = users.get(req.identity.id);
    if (!user) throw forbidden('no account');
    const next = checkPassword(req.body?.password);
    const current = typeof req.body?.current === 'string' ? req.body.current : '';
    if (!(await users.authenticate(user.email, current))) throw new HttpError(401, 'current password is wrong');
    await users.setPassword(user.id, next);
    users.deleteOtherSessions(user.id, req.identity.sessionId);
    users.audit({ userId: user.id, email: user.email, action: 'password.change' });
    return { ok: true };
  });
}

export { verifyPassword };
