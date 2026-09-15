/**
 * A directory on the local filesystem (which may well be an NFS/SMB mount —
 * the provider does not care). Symlinks inside a location are never followed:
 * a path resolves only when its `realpath` is exactly the path under the real
 * root, links are left out of listings, and writes refuse a link in the final
 * component (opened with O_NOFOLLOW). Grants and hidden names are checked on
 * the typed path, so following a link could lead past both.
 * Temporary upload parts live in `<root>/.mk-drive/uploads` so the final
 * rename is atomic on the same filesystem.
 */
import { constants, createWriteStream } from 'node:fs';
import { access, cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat, statfs, utimes } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { ExistsError, type ReadOptions, type StorageEntry, type StorageProvider, type StorageStat } from './provider.ts';

const UPLOAD_DIR = ['.mk-drive', 'uploads'];
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

export class LocalProvider implements StorageProvider {
  private readonly root: string;
  private rootReal: string | null = null;
  private readonly concurrency: number;

  constructor(root: string, opts: { concurrency?: number } = {}) {
    this.root = root;
    this.concurrency = Math.max(1, opts.concurrency ?? 32);
  }

  private async realRoot(): Promise<string> {
    if (!this.rootReal) this.rootReal = await realpath(this.root);
    return this.rootReal;
  }

  /** Absolute path of `segments`, or null if it does not exist or goes through a symlink. */
  localPath(segments: readonly string[]): Promise<string | null> {
    return this.resolve(segments);
  }

  async resolve(segments: readonly string[]): Promise<string | null> {
    const root = await this.realRoot();
    const abs = join(root, ...segments);
    if (abs !== root && !abs.startsWith(root + sep)) return null;
    try {
      return (await realpath(abs)) === abs ? abs : null;
    } catch {
      return null;
    }
  }

  /** Absolute path for something that may not exist yet: the parent must resolve inside the root. */
  private async resolveNew(segments: readonly string[]): Promise<string> {
    if (segments.length === 0) throw new Error('cannot create the root');
    const parent = await this.resolve(segments.slice(0, -1));
    if (!parent) throw new Error('parent does not exist');
    return join(parent, segments[segments.length - 1]);
  }

  /** Whether the name is taken — by anything, a (dangling) symlink included. */
  private async exists(abs: string): Promise<boolean> {
    try {
      await lstat(abs);
      return true;
    } catch {
      return false;
    }
  }

  async stat(segments: readonly string[]): Promise<StorageStat | null> {
    const abs = await this.resolve(segments);
    if (!abs) return null;
    try {
      return toStat(await stat(abs));
    } catch {
      return null;
    }
  }

  async list(segments: readonly string[], opts: { dirsOnly?: boolean } = {}): Promise<StorageEntry[]> {
    const abs = await this.resolve(segments);
    if (!abs) return [];
    const dirents = await readdir(abs, { withFileTypes: true });
    const out: StorageEntry[] = [];
    // symlinks are not followed, so they are not listed either
    const queue = dirents.filter((d) => !d.isSymbolicLink() && (!opts.dirsOnly || d.isDirectory()));
    let i = 0;
    const worker = async () => {
      while (i < queue.length) {
        const d = queue[i++];
        const p = join(abs, d.name);
        try {
          if (opts.dirsOnly && d.isDirectory()) {
            out.push({ name: d.name, kind: 'dir', size: 0, mtime: 0 });
            continue;
          }
          const ls = await lstat(p); // a filesystem that does not report types in readdir
          if (ls.isSymbolicLink()) continue;
          const s = toStat(ls);
          if (opts.dirsOnly && s.kind !== 'dir') continue;
          out.push({ name: d.name, ...s });
        } catch {
          // vanished between readdir and stat, or unreadable: leave it out
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length || 1) }, worker));
    return out;
  }

  async read(segments: readonly string[], opts: ReadOptions = {}): Promise<Readable> {
    const abs = await this.resolve(segments);
    if (!abs) throw new Error('not found');
    return (await open(abs, READ_FLAGS)).createReadStream({ start: opts.start, end: opts.end });
  }

  async space(): Promise<{ free: number; total: number } | null> {
    try {
      const s = await statfs(this.root);
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch {
      return null;
    }
  }

  async hasVersions(): Promise<boolean> {
    try {
      await access(join(this.root, '.zfs', 'snapshot'));
      return true;
    } catch {
      return false;
    }
  }

  // ---- versions: ZFS exposes snapshots as read-only trees under <root>/.zfs/snapshot/<name> ----

  /** The path inside the snapshot, only when no symlink is on the way (the same rule as the live tree). */
  private async snapshotPath(snapshot: string, segments: readonly string[]): Promise<string> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(snapshot)) throw new Error('bad snapshot name');
    const snapRoot = await realpath(join(this.root, '.zfs', 'snapshot', snapshot));
    const abs = join(snapRoot, ...segments);
    if ((await realpath(abs)) !== abs) throw new Error('not found');
    return abs;
  }

  async versions(segments: readonly string[]): Promise<{ snapshot: string; stat: StorageStat }[]> {
    let names: string[];
    try {
      names = await readdir(join(this.root, '.zfs', 'snapshot'));
    } catch {
      return [];
    }
    const out: { snapshot: string; stat: StorageStat }[] = [];
    await Promise.all(
      names.map(async (snapshot) => {
        try {
          const s = await stat(await this.snapshotPath(snapshot, segments));
          if (!s.isDirectory()) out.push({ snapshot, stat: toStat(s) });
        } catch {
          /* not in this snapshot */
        }
      }),
    );
    return out.sort((a, b) => b.snapshot.localeCompare(a.snapshot));
  }

  async readVersion(snapshot: string, segments: readonly string[], opts: ReadOptions = {}): Promise<Readable> {
    const p = await this.snapshotPath(snapshot, segments); // throws when missing
    return (await open(p, READ_FLAGS)).createReadStream({ start: opts.start, end: opts.end });
  }

  // ---- writes ----

  async mkdir(segments: readonly string[]): Promise<void> {
    const abs = await this.resolveNew(segments);
    if (await this.exists(abs)) throw new ExistsError(segments[segments.length - 1]);
    await mkdir(abs);
  }

  async rename(from: readonly string[], to: readonly string[], opts: { replace?: boolean } = {}): Promise<void> {
    const src = await this.resolve(from);
    if (!src) throw new Error('not found');
    const dst = await this.resolveNew(to);
    if (dst === src) return;
    if (dst.startsWith(src + sep)) throw new Error('cannot move a folder into itself');
    if (await this.exists(dst)) {
      if (!opts.replace) throw new ExistsError(to[to.length - 1]);
      await rm(dst, { recursive: true, force: true });
    }
    await rename(src, dst);
  }

  async copy(from: readonly string[], to: readonly string[], opts: { replace?: boolean } = {}): Promise<void> {
    const src = await this.resolve(from);
    if (!src) throw new Error('not found');
    const dst = await this.resolveNew(to);
    if (dst === src || dst.startsWith(src + sep)) throw new Error('cannot copy a folder into itself');
    if (await this.exists(dst)) {
      if (!opts.replace) throw new ExistsError(to[to.length - 1]);
      await rm(dst, { recursive: true, force: true });
    }
    await cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, dereference: false });
  }

  async remove(segments: readonly string[]): Promise<void> {
    const abs = await this.resolve(segments);
    if (!abs) return;
    await rm(abs, { recursive: true, force: true });
  }

  async write(segments: readonly string[], data: Readable, opts: { replace?: boolean; mtime?: number } = {}): Promise<void> {
    const dst = await this.resolveNew(segments);
    const name = segments[segments.length - 1];
    const before = await lstat(dst).catch(() => null);
    // a symlink in the name is refused, replace or not: writing would land wherever it points
    if (before && (before.isSymbolicLink() || !opts.replace)) {
      data.destroy();
      throw new ExistsError(name);
    }
    const file = await open(dst, WRITE_FLAGS).catch((e) => {
      data.destroy();
      throw e;
    });
    await pipeline(data, file.createWriteStream());
    if (opts.mtime) await utimes(dst, new Date(), new Date(opts.mtime)).catch(() => {});
  }

  async touch(segments: readonly string[], mtime: number): Promise<void> {
    const abs = await this.resolve(segments);
    if (abs) await utimes(abs, new Date(), new Date(mtime)).catch(() => {});
  }

  // ---- uploads ----

  private partPath(id: string): string {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('bad upload id');
    return join(this.root, ...UPLOAD_DIR, `${id}.part`);
  }

  async uploadBegin(id: string): Promise<void> {
    const p = this.partPath(id);
    await mkdir(dirname(p), { recursive: true });
    await pipeline(emptyStream(), createWriteStream(p, { flags: 'wx' }));
  }

  async uploadAppend(id: string, offset: number, data: Readable): Promise<number> {
    const p = this.partPath(id);
    const current = (await stat(p)).size;
    if (current !== offset) throw new OffsetError(current);
    await pipeline(data, createWriteStream(p, { flags: 'r+', start: offset }));
    return (await stat(p)).size;
  }

  async uploadSize(id: string): Promise<number | null> {
    try {
      return (await stat(this.partPath(id))).size;
    } catch {
      return null;
    }
  }

  async uploadCommit(id: string, dest: readonly string[], opts: { replace?: boolean; mtime?: number } = {}): Promise<void> {
    const p = this.partPath(id);
    const dst = await this.resolveNew(dest);
    if (await this.exists(dst)) {
      if (!opts.replace) throw new ExistsError(dest[dest.length - 1]);
      await rm(dst, { recursive: true, force: true });
    }
    await rename(p, dst);
    if (opts.mtime) await utimes(dst, new Date(), new Date(opts.mtime)).catch(() => {});
  }

  async uploadAbort(id: string): Promise<void> {
    await rm(this.partPath(id), { force: true });
  }
}

/** The client's offset does not match what was received; carries the truth. */
export class OffsetError extends Error {
  readonly received: number;
  constructor(received: number) {
    super(`offset mismatch, ${received} bytes received`);
    this.name = 'OffsetError';
    this.received = received;
  }
}

async function* nothing(): AsyncGenerator<Buffer> {}
function emptyStream(): AsyncIterable<Buffer> {
  return nothing();
}

function toStat(s: { isDirectory(): boolean; size: number; mtimeMs: number }): StorageStat {
  return s.isDirectory() ? { kind: 'dir', size: 0, mtime: Math.round(s.mtimeMs) } : { kind: 'file', size: s.size, mtime: Math.round(s.mtimeMs) };
}
