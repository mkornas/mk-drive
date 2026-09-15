/**
 * A WebDAV server as a location: Nextcloud, another mk-drive, anything that
 * speaks RFC 4918. PROPFIND for listing and stat, GET with ranges for reads,
 * PUT/MKCOL/MOVE/COPY/DELETE for writes — all through `fetch`, no library.
 * Chunked uploads stage locally (see `Staging`) and PUT on commit.
 */
import { Readable } from 'node:stream';
import { ExistsError, type ReadOptions, type StorageEntry, type StorageProvider, type StorageStat } from './provider.ts';
import type { Staging } from './staging.ts';

export interface WebDavConfig {
  /** The collection that becomes the location root, e.g. `https://cloud.example.com/remote.php/dav/files/anna/`. */
  url: string;
  username?: string;
  password?: string;
}

const TIMEOUT = 30_000;

/** One `<response>` of a multistatus body, prefixes ignored. */
interface DavEntry {
  href: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export function parseMultistatus(xml: string): DavEntry[] {
  const out: DavEntry[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi)) {
    const block = m[1];
    const href = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i.exec(block)?.[1]?.trim() ?? '';
    if (!href) continue;
    const dir = /<(?:[\w.-]+:)?collection\b[^>]*\/?>/i.test(block);
    const size = Number(/<(?:[\w.-]+:)?getcontentlength\b[^>]*>(\d+)</i.exec(block)?.[1] ?? 0);
    const mod = /<(?:[\w.-]+:)?getlastmodified\b[^>]*>([^<]+)</i.exec(block)?.[1];
    const mtime = mod ? Date.parse(mod) : NaN;
    out.push({ href: decodeURIComponent(href.replace(/&amp;/g, '&')), dir, size, mtime: Number.isFinite(mtime) ? mtime : 0 });
  }
  return out;
}

export class WebDavProvider implements StorageProvider {
  private readonly base: URL;
  private readonly auth: string | null;
  private readonly staging: Staging;

  constructor(cfg: WebDavConfig, staging: Staging) {
    this.base = new URL(cfg.url.endsWith('/') ? cfg.url : cfg.url + '/');
    this.auth = cfg.username ? `Basic ${Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64')}` : null;
    this.staging = staging;
  }

  private url(segments: readonly string[], dir = false): URL {
    const rel = segments.map(encodeURIComponent).join('/');
    return new URL(rel + (dir && rel ? '/' : ''), this.base);
  }

  private async req(method: string, url: URL, init: { headers?: Record<string, string>; body?: BodyInit | null; duplex?: 'half' } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.auth) headers.authorization = this.auth;
    const res = await fetch(url, {
      method,
      headers,
      body: init.body ?? null,
      signal: AbortSignal.timeout(TIMEOUT),
      ...(init.duplex ? { duplex: init.duplex } : {}),
    } as RequestInit);
    return res;
  }

  private async propfind(segments: readonly string[], depth: '0' | '1'): Promise<DavEntry[] | null> {
    // a collection is asked for with the trailing slash; a plain file without — try the file form first for depth 0 when unsure
    const res = await this.req('PROPFIND', this.url(segments, depth === '1'), {
      headers: { depth, 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new Error('the server refused the credentials');
    if (res.status !== 207) throw new Error(`webdav PROPFIND ${res.status} for ${segments.join('/') || '/'}`);
    return parseMultistatus(await res.text());
  }

  private pathOf(href: string): string {
    // hrefs may be absolute URLs or paths; compare on the path, without a trailing slash
    const p = href.startsWith('http') ? new URL(href).pathname : href;
    return decodeSafe(p).replace(/\/+$/, '');
  }

  async stat(segments: readonly string[]): Promise<StorageStat | null> {
    const entries = (await this.propfind(segments, '0')) ?? (segments.length ? await this.propfind(segments, '0') : null);
    if (!entries || !entries.length) return null;
    const e = entries[0];
    return { kind: e.dir ? 'dir' : 'file', size: e.dir ? 0 : e.size, mtime: e.mtime };
  }

  async list(segments: readonly string[], opts: { dirsOnly?: boolean } = {}): Promise<StorageEntry[]> {
    const entries = await this.propfind(segments, '1');
    if (!entries) throw new Error('not found');
    const self = this.pathOf(this.url(segments, true).pathname);
    const out: StorageEntry[] = [];
    for (const e of entries) {
      const p = this.pathOf(e.href);
      if (p === self) continue;
      const name = p.split('/').pop() ?? '';
      if (!name) continue;
      if (opts.dirsOnly && !e.dir) continue;
      out.push({ name, kind: e.dir ? 'dir' : 'file', size: e.dir ? 0 : e.size, mtime: e.mtime });
    }
    return out;
  }

  async read(segments: readonly string[], opts: ReadOptions = {}): Promise<Readable> {
    const headers: Record<string, string> = {};
    if (opts.start !== undefined || opts.end !== undefined) headers.range = `bytes=${opts.start ?? 0}-${opts.end ?? ''}`;
    const res = await this.req('GET', this.url(segments), { headers });
    if (!res.ok || !res.body) throw new Error(`webdav GET ${res.status}`);
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  }

  async space(): Promise<{ free: number; total: number } | null> {
    try {
      const res = await this.req('PROPFIND', this.base, {
        headers: { depth: '0', 'content-type': 'application/xml' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>',
      });
      if (res.status !== 207) return null;
      const xml = await res.text();
      const free = Number(/<(?:[\w.-]+:)?quota-available-bytes\b[^>]*>(-?\d+)</i.exec(xml)?.[1] ?? NaN);
      const used = Number(/<(?:[\w.-]+:)?quota-used-bytes\b[^>]*>(\d+)</i.exec(xml)?.[1] ?? NaN);
      if (!Number.isFinite(free) || free < 0 || !Number.isFinite(used)) return null;
      return { free, total: free + used };
    } catch {
      return null;
    }
  }

  async hasVersions(): Promise<boolean> {
    return false;
  }
  async versions(): Promise<{ snapshot: string; stat: StorageStat }[]> {
    return [];
  }
  async readVersion(): Promise<Readable> {
    throw new Error('no versions on a WebDAV location');
  }

  async mkdir(segments: readonly string[]): Promise<void> {
    const res = await this.req('MKCOL', this.url(segments, true));
    if (res.status === 405) throw new ExistsError(segments[segments.length - 1]);
    if (!res.ok) throw new Error(`webdav MKCOL ${res.status}`);
  }

  private async transfer(method: 'MOVE' | 'COPY', from: readonly string[], to: readonly string[], replace: boolean): Promise<void> {
    const st = await this.stat(from);
    if (!st) throw new Error('not found');
    if (!replace && (await this.stat(to))) throw new ExistsError(to[to.length - 1]);
    const res = await this.req(method, this.url(from, st.kind === 'dir'), {
      headers: { destination: this.url(to, st.kind === 'dir').toString(), overwrite: replace ? 'T' : 'F', depth: 'infinity' },
    });
    if (res.status === 412) throw new ExistsError(to[to.length - 1]);
    if (!res.ok) throw new Error(`webdav ${method} ${res.status}`);
  }

  rename(from: readonly string[], to: readonly string[], opts: { replace?: boolean } = {}): Promise<void> {
    return this.transfer('MOVE', from, to, !!opts.replace);
  }

  copy(from: readonly string[], to: readonly string[], opts: { replace?: boolean } = {}): Promise<void> {
    return this.transfer('COPY', from, to, !!opts.replace);
  }

  async remove(segments: readonly string[]): Promise<void> {
    const st = await this.stat(segments);
    if (!st) return;
    const res = await this.req('DELETE', this.url(segments, st.kind === 'dir'));
    if (!res.ok && res.status !== 404) throw new Error(`webdav DELETE ${res.status}`);
  }

  async write(segments: readonly string[], data: Readable, opts: { replace?: boolean; mtime?: number } = {}): Promise<void> {
    if (!opts.replace && (await this.stat(segments))) throw new ExistsError(segments[segments.length - 1]);
    const res = await this.req('PUT', this.url(segments), {
      body: Readable.toWeb(data) as unknown as BodyInit,
      duplex: 'half',
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`webdav PUT ${res.status}`);
  }

  async touch(): Promise<void> {
    /* WebDAV has no portable way to set mtime */
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
    const { stream } = await this.staging.take(id);
    await this.write(dest, stream, opts);
    await this.staging.abort(id);
  }
  uploadAbort(id: string): Promise<void> {
    return this.staging.abort(id);
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
