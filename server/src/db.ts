/**
 * The app's own metadata store: users, sessions, grants, audit — never files.
 * `node:sqlite` (built into Node 24), one file under the data dir, WAL mode.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member')),
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS grants (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('read','write')),
    PRIMARY KEY (user_id, location)
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    user_id INTEGER,
    email TEXT NOT NULL,
    action TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit(at)`,
  `CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    location TEXT NOT NULL,
    dest TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trash (
    id TEXT PRIMARY KEY,
    location TEXT NOT NULL,
    original TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    deleted_by INTEGER,
    deleted_by_email TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS trash_location ON trash(location, deleted_at)`,
  `CREATE TABLE IF NOT EXISTS stars (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, path)
  )`,
  `CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'browse',
    password_hash TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id)`,
  `CREATE TABLE IF NOT EXISTS connectors (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('webdav','s3')),
    mode TEXT NOT NULL CHECK (mode IN ('rw','ro')),
    icon TEXT NOT NULL,
    hide TEXT NOT NULL DEFAULT '[]',
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_passwords (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_ip TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    name TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    last_sent_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS user_shares (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('read','write')),
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, path)
  )`,
  `CREATE INDEX IF NOT EXISTS user_shares_owner ON user_shares(owner_id)`,
  `CREATE TABLE IF NOT EXISTS photo_dates (
    path TEXT NOT NULL,
    etag TEXT NOT NULL,
    taken INTEGER,
    PRIMARY KEY (path, etag)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS recent (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, path)
  )`,
];

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  for (const stmt of SCHEMA) db.exec(stmt);
  // columns added after the first release (CREATE TABLE IF NOT EXISTS does not touch an existing table)
  addColumn(db, 'sessions', 'via', "TEXT NOT NULL DEFAULT 'password'");
  // the provider's ID token, kept so signing out can end the provider's session without a confirmation page
  addColumn(db, 'sessions', 'id_token', 'TEXT');
  // an upload that came through a file-request link belongs to the link, not to a signed-in caller
  addColumn(db, 'uploads', 'share_id', 'TEXT');
  // what visitors already put through a file-request link, against its limits
  addColumn(db, 'shares', 'uploaded_files', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'shares', 'uploaded_bytes', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}

function addColumn(db: DatabaseSync, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

export type { DatabaseSync };
