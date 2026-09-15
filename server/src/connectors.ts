/**
 * Connectors: locations that are not host mounts — a WebDAV server or an S3
 * bucket, added by an admin in the app and kept in SQLite. Each becomes a
 * `Mounted` location like the others; grants, shares and the trash work the
 * same. Credentials sit in the same data dir as everything the app owns.
 */
import { join } from 'node:path';
import type { DatabaseSync } from './db.ts';
import type { Locations, Mounted } from './locations.ts';
import { S3Provider, type S3Config } from './storage/s3.ts';
import { Staging } from './storage/staging.ts';
import { WebDavProvider, type WebDavConfig } from './storage/webdav.ts';
import type { StorageProvider } from './storage/provider.ts';
import { badRequest } from './errors.ts';
import type { Connector, ConnectorInput, ConnectorType, LocationMode } from '../../shared/types.ts';

interface Row {
  name: string;
  type: ConnectorType;
  mode: LocationMode;
  icon: string;
  hide: string;
  config: string;
  created_at: number;
}

const NAME = /^[^/\\\0]{1,60}$/;

export class Connectors {
  private readonly db: DatabaseSync;
  private readonly locations: Locations;
  private readonly staging: Staging;
  private readonly tmp: string;

  constructor(db: DatabaseSync, locations: Locations, dataDir: string) {
    this.db = db;
    this.locations = locations;
    this.staging = new Staging(join(dataDir, 'staging'));
    this.tmp = join(dataDir, 'tmp');
  }

  /** Mount every saved connector (a broken one is logged and skipped, not fatal). */
  async init(log: { warn(msg: string): void }): Promise<void> {
    for (const row of this.db.prepare('SELECT * FROM connectors ORDER BY created_at').all() as unknown as Row[]) {
      try {
        this.mount(row);
      } catch (e) {
        log.warn(`connector ${row.name} not mounted: ${(e as Error).message}`);
      }
    }
  }

  list(): Connector[] {
    return (this.db.prepare('SELECT * FROM connectors ORDER BY created_at').all() as unknown as Row[]).map((r) => this.toPublic(r));
  }

  /** Validate, try the connection, save, mount. */
  async add(input: ConnectorInput): Promise<Connector> {
    const name = String(input.name ?? '').trim();
    if (!NAME.test(name)) throw badRequest('a name is required (no slashes)');
    if (this.locations.names.includes(name)) throw badRequest(`a location called "${name}" already exists`);
    const type: ConnectorType =
      input.type === 's3'
        ? 's3'
        : input.type === 'webdav'
          ? 'webdav'
          : (() => {
              throw badRequest('type must be webdav or s3');
            })();
    const config = type === 'webdav' ? checkWebDav(input.config) : checkS3(input.config);
    const row: Row = {
      name,
      type,
      mode: input.mode === 'ro' ? 'ro' : 'rw',
      icon: typeof input.icon === 'string' && input.icon.trim() ? input.icon.trim() : type === 's3' ? 'cloud' : 'globe',
      hide: JSON.stringify(Array.isArray(input.hide) ? input.hide.filter((h): h is string => typeof h === 'string') : []),
      config: JSON.stringify(config),
      created_at: Date.now(),
    };
    const provider = this.providerFor(row);
    // the root must answer before anything is saved
    const st = await Promise.race([provider.stat([]), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000).unref())]).catch((e: Error) => {
      throw badRequest(`could not connect: ${e.message}`);
    });
    if (st === 'timeout') throw badRequest('could not connect: no answer in 15 s');
    if (!st || st.kind !== 'dir') throw badRequest('could not connect: the root is not a folder (check the URL, bucket or prefix)');
    this.db
      .prepare('INSERT INTO connectors (name, type, mode, icon, hide, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.name, row.type, row.mode, row.icon, row.hide, row.config, row.created_at);
    this.locations.add(this.mounted(row, provider));
    return this.toPublic(row);
  }

  remove(name: string): boolean {
    const res = this.db.prepare('DELETE FROM connectors WHERE name = ?').run(name);
    if (!res.changes) return false;
    this.locations.remove(name);
    this.db.prepare('DELETE FROM grants WHERE location = ?').run(name);
    this.db.prepare("DELETE FROM user_shares WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(name, name.replace(/[%_\\]/g, '\\$&') + '/%');
    return true;
  }

  private mount(row: Row): void {
    this.locations.add(this.mounted(row, this.providerFor(row)));
  }

  private mounted(row: Row, provider: StorageProvider): Mounted {
    return { cfg: { name: row.name, path: '', mode: row.mode, hide: JSON.parse(row.hide) as string[], icon: row.icon, source: row.type }, provider };
  }

  private providerFor(row: Row): StorageProvider {
    const cfg = JSON.parse(row.config) as WebDavConfig | S3Config;
    return row.type === 'webdav' ? new WebDavProvider(cfg as WebDavConfig, this.staging) : new S3Provider(cfg as S3Config, this.staging, this.tmp);
  }

  /** What the admin page shows: no secrets. */
  private toPublic(r: Row): Connector {
    const cfg = JSON.parse(r.config) as Record<string, unknown>;
    const shown: Record<string, string> =
      r.type === 'webdav'
        ? { url: String(cfg.url ?? ''), username: String(cfg.username ?? '') }
        : {
            endpoint: String(cfg.endpoint ?? ''),
            region: String(cfg.region ?? ''),
            bucket: String(cfg.bucket ?? ''),
            prefix: String(cfg.prefix ?? ''),
            accessKey: String(cfg.accessKey ?? ''),
            pathStyle: cfg.pathStyle === false ? 'no' : 'yes',
          };
    return { name: r.name, type: r.type, mode: r.mode, icon: r.icon, hide: JSON.parse(r.hide) as string[], config: shown, createdAt: r.created_at };
  }
}

function str(v: unknown, what: string, required = true): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw badRequest(`${what} is required`);
  return s;
}

function checkWebDav(c: unknown): WebDavConfig {
  const o = (c ?? {}) as Record<string, unknown>;
  const url = str(o.url, 'the WebDAV URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('the WebDAV URL is not a URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw badRequest('the WebDAV URL must be http(s)');
  return { url, username: str(o.username, 'username', false) || undefined, password: typeof o.password === 'string' ? o.password : undefined };
}

function checkS3(c: unknown): S3Config {
  const o = (c ?? {}) as Record<string, unknown>;
  const endpoint = str(o.endpoint, 'the S3 endpoint');
  try {
    new URL(endpoint);
  } catch {
    throw badRequest('the S3 endpoint is not a URL');
  }
  return {
    endpoint,
    region: str(o.region, 'region', false) || 'us-east-1',
    bucket: str(o.bucket, 'the bucket'),
    prefix: str(o.prefix, 'prefix', false) || undefined,
    accessKey: str(o.accessKey, 'the access key'),
    secretKey: str(o.secretKey, 'the secret key'),
    pathStyle: o.pathStyle !== false && o.pathStyle !== 'no',
  };
}
