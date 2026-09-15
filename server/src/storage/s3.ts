/**
 * An S3 bucket (or a prefix inside one) as a location: AWS, MinIO, Backblaze,
 * Cloudflare R2 — anything with the S3 API. Signature V4 is done here with
 * `node:crypto`; no SDK. Folders are what S3 does not have: a "directory" is
 * a key prefix, shown when something lives under it or when an empty marker
 * object `prefix/` exists (which `mkdir` creates). Chunked uploads stage
 * locally and PUT on commit; every PUT needs the length up front.
 */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ExistsError, type ReadOptions, type StorageEntry, type StorageProvider, type StorageStat } from './provider.ts';
import type { Staging } from './staging.ts';

export interface S3Config {
  /** `https://s3.eu-central-1.amazonaws.com`, `https://minio.lan:9000`, `https://<account>.r2.cloudflarestorage.com` … */
  endpoint: string;
  region?: string;
  bucket: string;
  /** Optional key prefix that becomes the root (`photos/2026`). */
  prefix?: string;
  accessKey: string;
  secretKey: string;
  /** `https://endpoint/bucket/key` (default, MinIO/R2 friendly) or `https://bucket.endpoint/key`. */
  pathStyle?: boolean;
}

const TIMEOUT = 30_000;
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export class S3Provider implements StorageProvider {
  private readonly cfg: Required<Omit<S3Config, 'prefix'>> & { prefix: string };
  private readonly staging: Staging;
  private readonly tmp: string;

  constructor(cfg: S3Config, staging: Staging, tmpDir: string) {
    this.cfg = {
      region: 'us-east-1',
      pathStyle: true,
      ...cfg,
      prefix: (cfg.prefix ?? '').replace(/^\/+|\/+$/g, ''),
      endpoint: cfg.endpoint.replace(/\/+$/, ''),
    };
    this.staging = staging;
    this.tmp = tmpDir;
  }

  private key(segments: readonly string[]): string {
    return [this.cfg.prefix, ...segments].filter(Boolean).join('/');
  }

  private urlFor(key: string, query: Record<string, string> = {}): { url: URL; canonicalUri: string; canonicalQuery: string } {
    const base = new URL(this.cfg.endpoint);
    const keyPath = key.split('/').map(enc).join('/');
    let path: string;
    if (this.cfg.pathStyle) path = `/${enc(this.cfg.bucket)}${keyPath ? '/' + keyPath : ''}`;
    else {
      base.host = `${this.cfg.bucket}.${base.host}`;
      path = `/${keyPath}`;
    }
    const q = Object.keys(query)
      .sort()
      .map((k) => `${enc(k)}=${enc(query[k])}`)
      .join('&');
    const url = new URL(path + (q ? `?${q}` : ''), base);
    return { url, canonicalUri: path || '/', canonicalQuery: q };
  }

  /** Signature V4 with an unsigned payload (the body may be a stream). */
  private async req(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Readable | Buffer | null; length?: number } = {},
  ): Promise<Response> {
    const { url, canonicalUri, canonicalQuery } = this.urlFor(key, opts.query);
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', ...(opts.headers ?? {}) };
    if (opts.length !== undefined) headers['content-length'] = String(opts.length);
    const signed = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort();
    const canonicalHeaders = signed
      .map((h) => `${h}:${String(headers[h] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim()}\n`)
      .join('');
    const canonical = [method, canonicalUri, canonicalQuery, canonicalHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretKey}`, date), this.cfg.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
    const { host: _h, ...send } = headers;
    const body = opts.body instanceof Readable ? (Readable.toWeb(opts.body) as unknown as BodyInit) : (opts.body ?? null);
    return fetch(url, {
      method,
      headers: send,
      body,
      signal: AbortSignal.timeout(TIMEOUT),
      ...(opts.body instanceof Readable ? { duplex: 'half' } : {}),
    } as RequestInit);
  }

  private async listPage(
    prefix: string,
    delimiter: boolean,
    token?: string,
  ): Promise<{ files: { key: string; size: number; mtime: number }[]; dirs: string[]; next?: string }> {
    const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (delimiter) query.delimiter = '/';
    if (token) query['continuation-token'] = token;
    const res = await this.req('GET', '', { query });
    if (!res.ok) throw new Error(`s3 list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    const files = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
      key: unxml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] ?? ''),
      size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0),
      mtime: Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] ?? '') || 0,
    }));
    const dirs = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)].map((m) => unxml(m[1]));
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
    return { files, dirs, next: next ? unxml(next) : undefined };
  }

  async stat(segments: readonly string[]): Promise<StorageStat | null> {
    if (segments.length === 0) return { kind: 'dir', size: 0, mtime: 0 };
    const key = this.key(segments);
    const head = await this.req('HEAD', key);
    if (head.ok) {
      if (key.endsWith('/')) return { kind: 'dir', size: 0, mtime: 0 };
      return { kind: 'file', size: Number(head.headers.get('content-length') ?? 0), mtime: Date.parse(head.headers.get('last-modified') ?? '') || 0 };
    }
    if (head.status !== 404) throw new Error(`s3 HEAD ${head.status}`);
    const page = await this.listPage(key + '/', true);
    if (page.files.length || page.dirs.length) return { kind: 'dir', size: 0, mtime: 0 };
    return null;
  }

  async list(segments: readonly string[], opts: { dirsOnly?: boolean } = {}): Promise<StorageEntry[]> {
    const prefix = segments.length ? this.key(segments) + '/' : this.cfg.prefix ? this.cfg.prefix + '/' : '';
    const out: StorageEntry[] = [];
    let token: string | undefined;
    do {
      const page = await this.listPage(prefix, true, token);
      for (const d of page.dirs) out.push({ name: d.slice(prefix.length).replace(/\/$/, ''), kind: 'dir', size: 0, mtime: 0 });
      if (!opts.dirsOnly)
        for (const f of page.files)
          if (f.key !== prefix && !f.key.endsWith('/')) out.push({ name: f.key.slice(prefix.length), kind: 'file', size: f.size, mtime: f.mtime });
      token = page.next;
    } while (token);
    return out.filter((e) => e.name && !e.name.includes('/'));
  }

  async read(segments: readonly string[], opts: ReadOptions = {}): Promise<Readable> {
    const headers: Record<string, string> = {};
    if (opts.start !== undefined || opts.end !== undefined) headers.range = `bytes=${opts.start ?? 0}-${opts.end ?? ''}`;
    const res = await this.req('GET', this.key(segments), { headers });
    if (!res.ok || !res.body) throw new Error(`s3 GET ${res.status}`);
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  }

  async space(): Promise<null> {
    return null;
  }
  async hasVersions(): Promise<boolean> {
    return false;
  }
  async versions(): Promise<{ snapshot: string; stat: StorageStat }[]> {
    return [];
  }
  async readVersion(): Promise<Readable> {
    throw new Error('no versions on an S3 location');
  }

  async mkdir(segments: readonly string[]): Promise<void> {
    if (await this.stat(segments)) throw new ExistsError(segments[segments.length - 1]);
    const res = await this.req('PUT', this.key(segments) + '/', { body: Buffer.alloc(0), length: 0 });
    if (!res.ok) throw new Error(`s3 PUT ${res.status}`);
  }

  /** Every key under a path (the object itself, the marker, and everything below). */
  private async keysUnder(segments: readonly string[]): Promise<string[]> {
    const key = this.key(segments);
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.listPage(key + '/', false, token);
      keys.push(...page.files.map((f) => f.key));
      token = page.next;
    } while (token);
    if ((await this.req('HEAD', key)).ok) keys.push(key);
    return keys;
  }

  private async copyKey(from: string, to: string): Promise<void> {
    const source = `/${enc(this.cfg.bucket)}/${from.split('/').map(enc).join('/')}`;
    const res = await this.req('PUT', to, { headers: { 'x-amz-copy-source': source }, body: Buffer.alloc(0), length: 0 });
    if (!res.ok) throw new Error(`s3 copy ${res.status}`);
  }

  private async deleteKey(key: string): Promise<void> {
    const res = await this.req('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`s3 DELETE ${res.status}`);
  }

  private async transfer(from: readonly string[], to: readonly string[], replace: boolean, move: boolean): Promise<void> {
    if (!(await this.stat(from))) throw new Error('not found');
    if (!replace && (await this.stat(to))) throw new ExistsError(to[to.length - 1]);
    const src = this.key(from);
    const dst = this.key(to);
    for (const key of await this.keysUnder(from)) {
      const target = key === src ? dst : dst + key.slice(src.length);
      await this.copyKey(key, target);
      if (move) await this.deleteKey(key);
    }
  }

  rename(from: readonly string[], to: readonly string[], opts: { replace?: boolean } = {}): Promise<void> {
    return this.transfer(from, to, !!opts.replace, true);
  }
  copy(from: readonly string[], to: readonly string[], opts: { replace?: boolean } = {}): Promise<void> {
    return this.transfer(from, to, !!opts.replace, false);
  }

  async remove(segments: readonly string[]): Promise<void> {
    for (const key of await this.keysUnder(segments)) await this.deleteKey(key);
  }

  async write(segments: readonly string[], data: Readable, opts: { replace?: boolean; mtime?: number } = {}): Promise<void> {
    if (!opts.replace && (await this.stat(segments))) throw new ExistsError(segments[segments.length - 1]);
    // S3 wants the length first: spool to a temp file, then PUT it
    await mkdir(this.tmp, { recursive: true });
    const tmp = join(this.tmp, `s3-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await pipeline(data, createWriteStream(tmp));
      const size = (await stat(tmp)).size;
      const res = await this.req('PUT', this.key(segments), {
        body: createReadStream(tmp),
        length: size,
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (!res.ok) throw new Error(`s3 PUT ${res.status}`);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async touch(): Promise<void> {
    /* object mtimes are what S3 says they are */
  }

  uploadBegin(id: string): Promise<void> {
    return this.staging.begin(id);
  }
  uploadAppend(id: string, offset: number, data: Readable): Promise<number> {
    return this.staging.append(id, offset, data);
  }
  uploadSize(id: string): Promise<number | null> {
    return this.staging.size(id);
  }
  async uploadCommit(id: string, dest: readonly string[], opts: { replace?: boolean; mtime?: number } = {}): Promise<void> {
    if (!opts.replace && (await this.stat(dest))) throw new ExistsError(dest[dest.length - 1]);
    const { stream, size } = await this.staging.take(id);
    const res = await this.req('PUT', this.key(dest), { body: stream, length: size, headers: { 'content-type': 'application/octet-stream' } });
    if (!res.ok) throw new Error(`s3 PUT ${res.status}`);
    await this.staging.abort(id);
  }
  uploadAbort(id: string): Promise<void> {
    return this.staging.abort(id);
  }
}

function unxml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
