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
    /** The secret id of the session cookie in use, for sign-out and "the other sessions"; never sent to the client. */
    sessionId?: string;
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

/**
 * The real client address: Cloudflare's header, else X-Forwarded-For — either only when a trusted proxy sent it
 * (anyone can write the header; from an untrusted peer it would buy a fresh throttle key per request).
 */
export function clientIp(req: FastifyRequest, cidrs: string[]): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!isTrusted(peer, cidrs)) return peer;
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && isIP(cf)) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0].trim();
    if (isIP(first)) return first;
  }
  return peer;
}

/**
 * The path a guard should judge: the route that matched (what will run), else the decoded path. A raw `req.url`
 * check is fooled by `/%61pi/…`, which the router decodes to `/api/…`. Null when the path does not decode.
 */
export function routePath(req: FastifyRequest): string | null {
  if (req.routeOptions.url) return req.routeOptions.url;
  try {
    return decodeURIComponent(req.url.split('?')[0]);
  } catch {
    return null;
  }
}

const isDav = (path: string) => path === '/dav' || path.startsWith('/dav/');

// ---------- login throttle & helpers ----------

/** Failures older than this (after their pause) are forgotten. */
const FORGET_MS = 15 * 60_000;

/** Slows down password guessing: a growing pause per key (address, email) after failures. */
export class LoginThrottle {
  /** In order of the last failure, oldest first (a failure moves its key to the end). */
  private readonly failures = new Map<string, { count: number; until: number }>();
  /** Keys with an attempt being checked right now. */
  private readonly pending = new Set<string>();
  private readonly maxKeys: number;

  constructor(maxKeys = 10_000) {
    this.maxKeys = maxKeys;
  }

  /** Milliseconds the caller must still wait, 0 when allowed. */
  retryAfter(ip: string, now = Date.now()): number {
    const f = this.failures.get(ip);
    return f && f.until > now ? f.until - now : 0;
  }

  /**
   * Claims the keys for one attempt checked asynchronously: 0 when claimed (then `end` them once it is judged),
   * else the milliseconds to wait. A key with an attempt still in flight waits too, so a concurrent burst
   * is judged one attempt at a time instead of all slipping past the check.
   */
  begin(keys: string[], now = Date.now()): number {
    const wait = Math.max(0, ...keys.map((k) => this.retryAfter(k, now)));
    if (wait > 0) return wait;
    if (keys.some((k) => this.pending.has(k))) return 1000;
    for (const k of keys) this.pending.add(k);
    return 0;
  }

  end(keys: string[]): void {
    for (const k of keys) this.pending.delete(k);
  }

  failed(ip: string, now = Date.now()): void {
    let f = this.failures.get(ip);
    if (f && f.until + FORGET_MS < now) f = undefined;
    f ??= { count: 0, until: 0 };
    f.count += 1;
    f.until = now + Math.min(30_000, 1000 * 2 ** Math.min(f.count - 1, 5));
    this.failures.delete(ip);
    this.failures.set(ip, f);
    this.prune(now);
  }

  succeeded(ip: string): void {
    this.failures.delete(ip);
  }

  /** Drops forgotten keys, then the oldest ones past the cap (made-up emails must not grow the map without end). */
  private prune(now: number): void {
    if (this.failures.size <= this.maxKeys) return;
    for (const [k, f] of this.failures) {
      if (f.until + FORGET_MS >= now) break;
      this.failures.delete(k);
    }
    for (const k of this.failures.keys()) {
      if (this.failures.size <= this.maxKeys) break;
      this.failures.delete(k);
    }
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

/**
 * Whether the request came through Cloudflare, from its headers alone, whoever the peer is. Only ever used to
 * refuse or restrict (no password form, no tunnel changes, a Secure cookie): a client that fakes the headers
 * only holds itself back.
 */
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
    // WebDAV takes an app password only: a file it serves opens in the browser, which must not sign it in by itself
    const dav = isDav(routePath(req) ?? '');
    if (verifier && !dav) {
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
    const sid = dav ? undefined : cookie(req, SESSION_COOKIE);
    if (sid) {
      const s = users.session(sid);
      if (s) {
        req.sessionId = s.session.id;
        return { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role, via: 'session' };
      }
    }
    const cred = bearerFrom(req.headers);
    if (cred) {
      // no await between the check and the verdict below, so a concurrent burst cannot slip past it
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

/** NAS mode's read-only monitor route (GET only): its own token, checked and throttled by the route; a session or an app password never opens it. */
export const NAS_MONITOR_PATH = '/api/nas/monitor';

export function registerAuth(app: FastifyInstance, auth: Auth): void {
  app.decorateRequest('identity', undefined as unknown as Identity);
  app.decorateRequest('authReason', undefined);
  app.decorateRequest('sessionId', undefined);
  app.addHook('onRequest', async (req, reply) => {
    const path = routePath(req);
    if (path === null) return reply.code(400).send({ ok: false, message: 'bad path' });
    const dav = isDav(path);
    if (!path.startsWith('/api/') && !dav) return;
    if (dav) {
      if (req.method === 'OPTIONS') return; // clients probe before they authenticate
      const id = await auth.identify(req);
      if (id) {
        req.identity = id;
        return;
      }
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="mk-drive", charset="UTF-8"')
        .send(req.authReason ?? 'sign in with your email and an app password');
    }
    if (path === NAS_MONITOR_PATH && req.method === 'GET') return;
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
