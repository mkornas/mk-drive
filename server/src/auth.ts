/**
 * Who is asking? Two ways in, checked in this order:
 *  1. Cloudflare Access — `Cf-Access-Jwt-Assertion` header (or the CF_Authorization
 *     cookie), a JWT signed by the team's keys, verified against
 *     https://<team>.cloudflareaccess.com/cdn-cgi/access/certs; its email must
 *     belong to an enabled local user (no auto-provisioning);
 *  2. our own session cookie, issued by a password login.
 * Only /api/* is guarded — the SPA itself is public and shows the login page.
 */
import { type AccessVerifier, accessTokenFrom, createAccessVerifier, viaCloudflare as viaCf } from '@mk-kit/auth/server';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { Identity } from '../../shared/types.ts';
import type { Users } from './users.ts';

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity;
    /** Why a presented credential was refused (shown on the login page). */
    authReason?: string;
  }
}

export const SESSION_COOKIE = 'mkdrive_session';

/** App passwords are long random secrets, so a plain hash is enough to store and look them up. */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url');
}

/** `Authorization: Basic base64(email:secret)` (WebDAV, curl -u) or `Bearer secret`; null when neither. */
export function bearerFrom(headers: FastifyRequest['headers']): { email: string | null; secret: string } | null {
  const h = headers.authorization;
  if (typeof h !== 'string') return null;
  const [scheme, rest] = h.split(/\s+/, 2);
  if (!rest) return null;
  if (/^bearer$/i.test(scheme)) return { email: null, secret: rest.trim() };
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(rest.trim(), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return { email: decoded.slice(0, i).trim().toLowerCase(), secret: decoded.slice(i + 1) };
  }
  return null;
}

// ---------- CIDR matching (v4, v6 and v4-mapped v6) ----------

function ipToBytes(ip: string): Uint8Array | null {
  const v = isIP(ip);
  if (v === 4) return Uint8Array.from(ip.split('.').map(Number));
  if (v !== 6) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return ipToBytes(mapped[1]);
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g || '0', 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const a = ipToBytes(ip);
  const b = ipToBytes(net);
  if (!a || !b || a.length !== b.length) return false;
  const bits = bitsRaw === undefined ? a.length * 8 : Number(bitsRaw);
  for (let i = 0; i < a.length; i++) {
    const remaining = bits - i * 8;
    if (remaining <= 0) return true;
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

export function isTrusted(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

/** The real client address: Cloudflare's header, else X-Forwarded-For only when a trusted proxy sent it. */
export function clientIp(req: FastifyRequest, cidrs: string[]): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && isIP(cf)) return cf;
  const peer = req.socket.remoteAddress ?? '';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && isTrusted(peer, cidrs)) {
    const first = xff.split(',')[0].trim();
    if (isIP(first)) return first;
  }
  return peer;
}

// ---------- login throttle & helpers ----------

/** Slows down password guessing: a growing pause per source address after failures. */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; until: number }>();

  /** Milliseconds the caller must still wait, 0 when allowed. */
  retryAfter(ip: string, now = Date.now()): number {
    const f = this.failures.get(ip);
    return f && f.until > now ? f.until - now : 0;
  }

  failed(ip: string, now = Date.now()): void {
    const f = this.failures.get(ip) ?? { count: 0, until: 0 };
    f.count += 1;
    f.until = now + Math.min(30_000, 1000 * 2 ** Math.min(f.count - 1, 5));
    this.failures.set(ip, f);
  }

  succeeded(ip: string): void {
    this.failures.delete(ip);
  }
}

export function cookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function viaCloudflare(req: FastifyRequest): boolean {
  return viaCf(req.headers);
}

/** Private, loopback and link-local ranges — "the LAN" for `DRIVE_PASSWORD_LOGIN=lan`. */
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', 'fe80::/10', '::1/128'];

/** Whether the password form is offered to this request (`DRIVE_PASSWORD_LOGIN`). */
export function passwordLoginAllowed(req: FastifyRequest, cfg: Pick<Config, 'passwordLogin' | 'trustedProxies'>): boolean {
  if (cfg.passwordLogin === 'on') return true;
  if (cfg.passwordLogin === 'off') return false;
  return !viaCloudflare(req) && isTrusted(clientIp(req, cfg.trustedProxies), PRIVATE);
}

/** Whether the client reached us over TLS (directly or through a proxy that says so). */
export function isSecure(req: FastifyRequest): boolean {
  if (viaCloudflare(req)) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

export interface Auth {
  verifier: AccessVerifier | null;
  throttle: LoginThrottle;
  /** Resolve the identity of a request; `null` = nobody. Sets `req.authReason` when a credential was refused. */
  identify(req: FastifyRequest): Promise<Identity | null>;
}

export function createAuth(cfg: Config, users: Users): Auth {
  const verifier = cfg.accessAud ? createAccessVerifier({ team: cfg.accessTeam, aud: cfg.accessAud }) : null;
  const throttle = new LoginThrottle();

  const identify = async (req: FastifyRequest): Promise<Identity | null> => {
    if (verifier) {
      const token = accessTokenFrom(req.headers);
      if (token) {
        try {
          const email = (await verifier.verify(token)).email;
          const user = email ? users.byEmail(email) : null;
          if (user && !user.disabled) return { id: user.id, email: user.email, name: user.name, role: user.role, via: 'access' };
          req.authReason = user ? 'this account is disabled' : `no account for ${email || 'this identity'}`;
        } catch (e) {
          req.authReason = `access token rejected: ${(e as Error).message}`;
          req.log.warn(req.authReason);
        }
      }
    }
    const sid = cookie(req, SESSION_COOKIE);
    if (sid) {
      const s = users.session(sid);
      if (s) return { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role, via: 'session', sessionId: s.session.id };
    }
    const cred = bearerFrom(req.headers);
    if (cred) {
      const ip = clientIp(req, cfg.trustedProxies);
      if (throttle.retryAfter(`token:${ip}`) > 0) {
        req.authReason = 'too many attempts, wait a moment';
        return null;
      }
      const found = users.appPassword(hashToken(cred.secret));
      const user = found ? users.get(found.user_id) : null;
      if (found && user && !user.disabled && (cred.email === null || cred.email === user.email.toLowerCase())) {
        throttle.succeeded(`token:${ip}`);
        users.touchAppPassword(found.id, ip);
        return { id: user.id, email: user.email, name: user.name, role: user.role, via: 'token', tokenId: found.id };
      }
      throttle.failed(`token:${ip}`);
      req.authReason = 'app password rejected';
    }
    return null;
  };

  return { verifier, throttle, identify };
}

/** Endpoints reachable without an identity (they handle it themselves). */
const OPEN = new Set(['/api/health', '/api/meta', '/api/login', '/api/logout', '/api/setup']);

export function registerAuth(app: FastifyInstance, auth: Auth): void {
  app.decorateRequest('identity', undefined as unknown as Identity);
  app.decorateRequest('authReason', undefined);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    const dav = path === '/dav' || path.startsWith('/dav/');
    if (!path.startsWith('/api/') && !dav) return;
    if (dav) {
      if (req.method === 'OPTIONS') return; // clients probe before they authenticate
      const id = await auth.identify(req);
      if (id) {
        req.identity = id;
        return;
      }
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="mk-drive", charset="UTF-8"').send(req.authReason ?? 'sign in with your email and an app password');
    }
    if (path.startsWith('/api/s/')) {
      // public share links carry their own checks; still attach an identity when there is one
      const id = await auth.identify(req).catch(() => null);
      if (id) req.identity = id;
      return;
    }
    const id = await auth.identify(req);
    if (id) {
      req.identity = id;
      return;
    }
    if (OPEN.has(path)) return;
    if (req.headers.authorization || req.headers['user-agent']?.startsWith('curl')) reply.header('WWW-Authenticate', 'Basic realm="mk-drive", charset="UTF-8"');
    return reply.code(401).send({ ok: false, message: req.authReason ?? 'sign in' });
  });
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, sessionId: string, maxAgeSeconds: number): void {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isSecure(req)) attrs.push('Secure');
  reply.header('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) attrs.push('Secure');
  reply.header('Set-Cookie', attrs.join('; '));
}
