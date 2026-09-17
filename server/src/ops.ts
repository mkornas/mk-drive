/**
 * File operations on top of the providers: folders, rename, move, copy,
 * trash (with restore and purge), cross-location copies, zip streams.
 * Conflict policy: `fail` (409), `replace`, or `rename` ("name (2).ext").
 */
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import type { DatabaseSync } from './db.ts';
import type { Mounted } from './locations.ts';
import { ExistsError, type StorageProvider } from './storage/provider.ts';
import { joinDrivePath } from './paths.ts';
import { badRequest, HttpError } from './errors.ts';
import type { ConflictPolicy, TrashEntry } from '../../shared/types.ts';

export const TRASH_DIR = ['.mk-drive', 'trash'];
const NAME_BAD = /[\0/\\]/;

export function checkName(name: unknown): string {
  if (typeof name !== 'string') throw badRequest('a name is required');
  const n = name.trim();
  if (!n || n === '.' || n === '..' || NAME_BAD.test(n) || n.length > 255) throw badRequest(`"${name}" is not a valid name`);
  return n;
}

export function parsePolicy(raw: unknown): ConflictPolicy {
  return raw === 'replace' || raw === 'rename' ? raw : 'fail';
}

/** "photo.jpg" → "photo (2).jpg", "photo (2).jpg" → "photo (3).jpg". */
export function nextName(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const m = /^(.*) \((\d+)\)$/.exec(base);
  const stem = m ? m[1] : base;
  let n = m ? Number(m[2]) + 1 : 2;
  return (async () => {
    for (; n < 10_000; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!(await taken(candidate))) return candidate;
    }
    throw new HttpError(409, 'too many copies of that name');
  })();
}

/** Run `attempt(name, replace)` honouring the policy; returns the final name. */
export async function withPolicy(name: string, policy: ConflictPolicy, exists: (n: string) => Promise<boolean>, attempt: (n: string, replace: boolean) => Promise<void>): Promise<string> {
  if (policy === 'replace') {
    await attempt(name, true);
    return name;
  }
  if (policy === 'rename' && (await exists(name))) {
    const fresh = await nextName(name, exists);
    await attempt(fresh, false);
    return fresh;
  }
  try {
    await attempt(name, false);
    return name;
  } catch (e) {
    if (e instanceof ExistsError) throw new HttpError(409, `"${name}" already exists`);
    throw e;
  }
}

export class Ops {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async exists(p: StorageProvider, segments: readonly string[]): Promise<boolean> {
    return (await p.stat(segments)) !== null;
  }

  async mkdir(loc: Mounted, dir: readonly string[], name: string, policy: ConflictPolicy): Promise<string> {
    return withPolicy(name, policy === 'replace' ? 'fail' : policy, (n) => this.exists(loc.provider, [...dir, n]), (n) => loc.provider.mkdir([...dir, n]));
  }

  /**
   * Public links and shares with people are kept by path. When the drive itself moves what they point at, they go
   * along (whatever was at the new path before was replaced, and its links end); otherwise the old path, taken by
   * something new later, would open that to whoever holds the old link.
   */
  relink(from: string, to: string): void {
    if (from === to) return;
    this.unlink(to);
    for (const table of ['shares', 'user_shares'])
      this.db.prepare(`UPDATE ${table} SET path = ? || substr(path, ?) WHERE path = ? OR substr(path, 1, ?) = ?`).run(to, from.length + 1, from, from.length + 1, `${from}/`);
  }

  /** What was at `path` is gone (to the trash, or replaced): the links to it and to anything inside end. */
  unlink(path: string): void {
    for (const table of ['shares', 'user_shares']) this.db.prepare(`DELETE FROM ${table} WHERE path = ? OR substr(path, 1, ?) = ?`).run(path, path.length + 1, `${path}/`);
  }

  async rename(loc: Mounted, segments: readonly string[], name: string, policy: ConflictPolicy): Promise<string> {
    const dir = segments.slice(0, -1);
    if (segments[segments.length - 1] === name) return name;
    const final = await withPolicy(name, policy, (n) => this.exists(loc.provider, [...dir, n]), (n, replace) => loc.provider.rename(segments, [...dir, n], { replace }));
    this.relink(joinDrivePath(loc.cfg.name, segments), joinDrivePath(loc.cfg.name, [...dir, final]));
    return final;
  }

  /** Move `segments` from `src` into directory `dir` of `dst`; cross-location = copy then remove. */
  async move(src: Mounted, segments: readonly string[], dst: Mounted, dir: readonly string[], policy: ConflictPolicy): Promise<string> {
    const name = segments[segments.length - 1];
    if (src === dst) {
      if (dir.join('/') === segments.slice(0, -1).join('/')) return name;
      const moved = await withPolicy(name, policy, (n) => this.exists(dst.provider, [...dir, n]), (n, replace) => src.provider.rename(segments, [...dir, n], { replace }));
      this.relink(joinDrivePath(src.cfg.name, segments), joinDrivePath(dst.cfg.name, [...dir, moved]));
      return moved;
    }
    const final = await this.copy(src, segments, dst, dir, policy);
    await src.provider.remove(segments);
    this.relink(joinDrivePath(src.cfg.name, segments), joinDrivePath(dst.cfg.name, [...dir, final]));
    return final;
  }

  async copy(src: Mounted, segments: readonly string[], dst: Mounted, dir: readonly string[], policy: ConflictPolicy): Promise<string> {
    const name = segments[segments.length - 1];
    if (src === dst) {
      return withPolicy(name, policy, (n) => this.exists(dst.provider, [...dir, n]), (n, replace) => src.provider.copy(segments, [...dir, n], { replace }));
    }
    return withPolicy(name, policy, (n) => this.exists(dst.provider, [...dir, n]), async (n, replace) => {
      if (replace) await dst.provider.remove([...dir, n]);
      await copyBetween(src.provider, segments, dst.provider, [...dir, n]);
    });
  }

  // ---- trash ----

  async trash(loc: Mounted, segments: readonly string[], who: { id: number; email: string }): Promise<TrashEntry> {
    const st = await loc.provider.stat(segments);
    if (!st) throw new HttpError(404, 'not found');
    const name = segments[segments.length - 1];
    const id = randomBytes(12).toString('base64url');
    try {
      await ensureDir(loc.provider, TRASH_DIR);
    } catch (e) {
      // a remote that refuses the hidden folder (another mk-drive does) cannot hold a trash; better to say so than to delete for good
      throw new HttpError(409, `this location cannot keep a trash folder (${(e as Error).message}); delete it on the other side`);
    }
    await loc.provider.rename(segments, [...TRASH_DIR, `${id}__${name}`]);
    this.unlink(joinDrivePath(loc.cfg.name, segments));
    const entry: TrashEntry = { id, location: loc.cfg.name, original: joinDrivePath(loc.cfg.name, segments), name, kind: st.kind, size: st.size, deletedAt: Date.now(), deletedBy: who.email };
    this.db.prepare('INSERT INTO trash (id, location, original, name, kind, size, deleted_at, deleted_by, deleted_by_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, entry.location, entry.original, name, st.kind, st.size, entry.deletedAt, who.id, who.email);
    return entry;
  }

  trashList(location: string): TrashEntry[] {
    return (this.db.prepare('SELECT * FROM trash WHERE location = ? ORDER BY deleted_at DESC').all(location) as unknown as TrashRow[]).map(toTrashEntry);
  }

  trashGet(id: string): TrashEntry | null {
    const row = this.db.prepare('SELECT * FROM trash WHERE id = ?').get(id) as unknown as TrashRow | undefined;
    return row ? toTrashEntry(row) : null;
  }

  /** Put it back where it was (parents recreated), honouring the policy. Returns the final drive path. */
  async restore(loc: Mounted, entry: TrashEntry, policy: ConflictPolicy): Promise<string> {
    const segments = entry.original.split('/').slice(1);
    const dir = segments.slice(0, -1);
    await ensureDir(loc.provider, dir);
    const final = await withPolicy(entry.name, policy, (n) => this.exists(loc.provider, [...dir, n]), (n, replace) => loc.provider.rename([...TRASH_DIR, `${entry.id}__${entry.name}`], [...dir, n], { replace }));
    this.db.prepare('DELETE FROM trash WHERE id = ?').run(entry.id);
    return joinDrivePath(loc.cfg.name, [...dir, final]);
  }

  async purge(loc: Mounted, entry: TrashEntry): Promise<void> {
    await loc.provider.remove([...TRASH_DIR, `${entry.id}__${entry.name}`]);
    this.db.prepare('DELETE FROM trash WHERE id = ?').run(entry.id);
  }

  /** Entries older than `days`, for the periodic sweep. */
  expired(days: number): TrashEntry[] {
    return (this.db.prepare('SELECT * FROM trash WHERE deleted_at < ?').all(Date.now() - days * 86_400_000) as unknown as TrashRow[]).map(toTrashEntry);
  }

  // ---- zip ----

  /** A store-only zip of the given entries (files and whole folders), streamed. */
  async zip(loc: Mounted, items: readonly (readonly string[])[], hidden: (segments: readonly string[]) => boolean): Promise<Readable> {
    const archive = new ZipArchive({ store: true });
    const add = async (segments: readonly string[], rel: string): Promise<void> => {
      if (hidden(segments)) return;
      const st = await loc.provider.stat(segments);
      if (!st) return;
      if (st.kind === 'file') {
        archive.append(await loc.provider.read(segments), { name: rel, date: new Date(st.mtime) });
        return;
      }
      archive.append('', { name: `${rel}/`, date: new Date(st.mtime) });
      for (const child of await loc.provider.list(segments)) await add([...segments, child.name], `${rel}/${child.name}`);
    };
    void (async () => {
      try {
        for (const segments of items) await add(segments, segments[segments.length - 1] ?? loc.cfg.name);
        await archive.finalize();
      } catch (e) {
        archive.destroy(e as Error);
      }
    })();
    return archive;
  }
}

interface TrashRow {
  id: string;
  location: string;
  original: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  deleted_at: number;
  deleted_by_email: string;
}

function toTrashEntry(r: TrashRow): TrashEntry {
  return { id: r.id, location: r.location, original: r.original, name: r.name, kind: r.kind, size: r.size, deletedAt: r.deleted_at, deletedBy: r.deleted_by_email };
}

/** mkdir -p through the provider interface. */
export async function ensureDir(p: StorageProvider, segments: readonly string[]): Promise<void> {
  for (let i = 1; i <= segments.length; i++) {
    const part = segments.slice(0, i);
    if (!(await p.stat(part))) await p.mkdir(part);
  }
}

/** Recursive copy from one provider to another through streams. */
export async function copyBetween(src: StorageProvider, from: readonly string[], dst: StorageProvider, to: readonly string[]): Promise<void> {
  const st = await src.stat(from);
  if (!st) throw new HttpError(404, 'not found');
  if (st.kind === 'file') {
    await dst.write(to, await src.read(from), { mtime: st.mtime });
    return;
  }
  await dst.mkdir(to);
  for (const child of await src.list(from)) await copyBetween(src, [...from, child.name], dst, [...to, child.name]);
}
