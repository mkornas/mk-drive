/** Users, passwords, sessions, grants and the audit log over the SQLite store. */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from './db.ts';
import type { AccessLevel, AuditEntry, Role, Session, User } from '../../shared/types.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const PASSWORD_MIN = 10;

/**
 * What the client sees of a session: a hash of its secret id. The id is 256 random bits, so the hash tells nothing
 * and needs no key or column; the cookie alone carries the secret.
 */
export function publicSessionId(id: string): string {
  return createHash('sha256').update(`session:${id}`).digest('base64url').slice(0, 24);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash nobody's password matches, made on first use: what `authenticate` checks against when there is no account to check. */
let decoy: Promise<string> | null = null;

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

interface SessionRow {
  id: string;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string;
  ip: string;
  /** How the session began: `password`, or `sso` (then signing out also ends the provider's session). */
  via: SessionVia;
  /** The provider's ID token for an `sso` session — the logout hint. */
  id_token: string | null;
}

export type SessionVia = 'password' | 'sso';

export interface AppPasswordRow {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  last_ip: string;
}

export interface SessionWithUser {
  session: SessionRow;
  user: UserRow;
}

export class Users {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Every account's id and email, oldest first. */
  accounts(): { id: number; email: string }[] {
    return this.db.prepare('SELECT id, email FROM users ORDER BY id').all() as { id: number; email: string }[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  private toUser(row: UserRow): User {
    const grants: Record<string, AccessLevel> = {};
    for (const g of this.db.prepare('SELECT location, level FROM grants WHERE user_id = ?').all(row.id) as { location: string; level: AccessLevel }[])
      grants[g.location] = g.level;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      disabled: !!row.disabled,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      grants,
    };
  }

  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as UserRow[]).map((r) => this.toUser(r));
  }

  get(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? this.toUser(row) : null;
  }

  byEmail(email: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    return row ? this.toUser(row) : null;
  }

  async create(input: { email: string; name: string; role: Role; password: string; grants?: Record<string, AccessLevel> }): Promise<User> {
    const hash = await hashPassword(input.password);
    const res = this.db
      .prepare('INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.email.trim(), input.name.trim(), input.role, hash, Date.now());
    const id = Number(res.lastInsertRowid);
    if (input.grants) this.setGrants(id, input.grants);
    return this.get(id)!;
  }

  update(id: number, patch: { name?: string; role?: Role; disabled?: boolean; email?: string }): User | null {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), vals.push(patch.name.trim()));
    if (patch.email !== undefined) (sets.push('email = ?'), vals.push(patch.email.trim()));
    if (patch.role !== undefined) (sets.push('role = ?'), vals.push(patch.role));
    if (patch.disabled !== undefined) (sets.push('disabled = ?'), vals.push(patch.disabled ? 1 : 0));
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as (string | number)[]), id);
    if (patch.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return this.get(id);
  }

  async setPassword(id: number, password: string): Promise<void> {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  admins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
  }

  /** Email + password → user, or null. Updates last_login_at on success. */
  async authenticate(email: string, password: string): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    // one scrypt whoever asks: no account, a disabled one or one without a password must take as long as a wrong password,
    // or the time alone says which emails have an account here
    const usable = !!row && !row.disabled && row.password_hash.startsWith('scrypt$');
    const right = await verifyPassword(password, usable ? row.password_hash : await (decoy ??= hashPassword(randomBytes(16).toString('hex'))));
    if (!row || !usable || !right) return null;
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
    return this.toUser(row);
  }

  markLogin(id: number): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // ---- app passwords ----
  appPasswords(userId: number): AppPasswordRow[] {
    return this.db.prepare('SELECT * FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC').all(userId) as unknown as AppPasswordRow[];
  }

  appPassword(tokenHash: string): AppPasswordRow | null {
    return (this.db.prepare('SELECT * FROM app_passwords WHERE token_hash = ?').get(tokenHash) as unknown as AppPasswordRow | undefined) ?? null;
  }

  createAppPassword(userId: number, name: string, tokenHash: string, prefix: string): AppPasswordRow {
    const res = this.db
      .prepare('INSERT INTO app_passwords (user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, tokenHash, prefix, Date.now());
    return this.db.prepare('SELECT * FROM app_passwords WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as AppPasswordRow;
  }

  /** Remember the last use, at most once a minute per password (it runs on every request). */
  touchAppPassword(id: number, ip: string): void {
    this.db
      .prepare('UPDATE app_passwords SET last_used_at = ?, last_ip = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
      .run(Date.now(), ip, id, Date.now() - 60_000);
  }

  deleteAppPassword(userId: number, id: number): boolean {
    return this.db.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  /** Every app password of the account (after a password change or reset); how many there were. */
  deleteAppPasswordsOf(userId: number): number {
    return Number(this.db.prepare('DELETE FROM app_passwords WHERE user_id = ?').run(userId).changes);
  }

  setGrants(userId: number, grants: Record<string, AccessLevel>): void {
    const del = this.db.prepare('DELETE FROM grants WHERE user_id = ?');
    const ins = this.db.prepare('INSERT INTO grants (user_id, location, level) VALUES (?, ?, ?)');
    del.run(userId);
    for (const [location, level] of Object.entries(grants)) if (level === 'read' || level === 'write') ins.run(userId, location, level);
  }

  // ---------- sessions ----------

  createSession(userId: number, ttlMs: number, meta: { userAgent?: string; ip?: string; via?: SessionVia; idToken?: string } = {}): SessionRow {
    const now = Date.now();
    const row: SessionRow = {
      id: randomBytes(32).toString('base64url'),
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      expires_at: now + ttlMs,
      user_agent: (meta.userAgent ?? '').slice(0, 200),
      ip: meta.ip ?? '',
      via: meta.via ?? 'password',
      id_token: meta.idToken ?? null,
    };
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, via, id_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.created_at, row.last_seen_at, row.expires_at, row.user_agent, row.ip, row.via, row.id_token);
    return row;
  }

  /** How a live session began, or null when it is gone. */
  /** How a session began and, for an SSO one, the ID token to hand back to the provider on sign-out. */
  sessionOrigin(id: string): { via: SessionVia; idToken: string | null } | null {
    const s = this.db.prepare('SELECT via, id_token FROM sessions WHERE id = ?').get(id) as { via: SessionVia; id_token: string | null } | undefined;
    return s ? { via: s.via, idToken: s.id_token } : null;
  }

  /** The session and its user when the id is valid, not expired and the user is enabled. Touches last_seen (throttled). */
  session(id: string): SessionWithUser | null {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!s) return null;
    const now = Date.now();
    if (s.expires_at < now) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as UserRow | undefined;
    if (!user || user.disabled) return null;
    if (now - s.last_seen_at > 60_000) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
    return { session: s, user };
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** Deletes one of the user's sessions by its public id; false when there is none. */
  deleteSessionOf(userId: number, publicId: string): boolean {
    const rows = this.db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as { id: string }[];
    const row = rows.find((r) => publicSessionId(r.id) === publicId);
    if (row) this.deleteSession(row.id);
    return !!row;
  }

  deleteOtherSessions(userId: number, keep: string | undefined): void {
    if (keep) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keep);
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  sessionsOf(userId: number, current?: string): Session[] {
    return (
      this.db
        .prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
        .all(userId, Date.now()) as unknown as SessionRow[]
    ).map((s) => ({
      id: publicSessionId(s.id),
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      userAgent: s.user_agent,
      ip: s.ip,
      current: s.id === current,
    }));
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  // ---------- audit ----------

  audit(entry: { userId: number | null; email: string; action: string; path?: string; detail?: unknown }): void {
    this.db
      .prepare('INSERT INTO audit (at, user_id, email, action, path, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        Date.now(),
        entry.userId,
        entry.email,
        entry.action,
        entry.path ?? '',
        entry.detail === undefined ? '' : typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail),
      );
  }

  auditList(limit = 200, before?: number): AuditEntry[] {
    const rows = before
      ? this.db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
      : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as { id: number; at: number; user_id: number | null; email: string; action: string; path: string; detail: string }[]).map((r) => ({
      id: r.id,
      at: r.at,
      userId: r.user_id,
      email: r.email,
      action: r.action,
      path: r.path,
      detail: r.detail,
    }));
  }
}

/** Effective access of a user to a location, before the location's own mode is applied. */
export function grantLevel(user: Pick<User, 'role' | 'grants'>, location: string): AccessLevel {
  if (user.role === 'admin') return 'write';
  return user.grants[location] ?? 'none';
}
