/**
 * The photo timeline: every image and video under a location, newest first.
 * There is no index (the filesystem is the truth), so this is a bounded walk
 * like the search, kept for a couple of minutes per location so paging and a
 * second look do not walk again. The date is when the picture was taken
 * (EXIF), read once per file version through sharp and kept in a small
 * disposable table; files without one (and every video) fall back to their
 * modification time. Extraction is budgeted per walk, so a big first import
 * fills in over a few visits instead of blocking one.
 */
import sharp from 'sharp';
import type { DatabaseSync } from './db.ts';
import type { Mounted } from './locations.ts';
import { entryOf } from './entries.ts';
import { dateTaken } from './exif.ts';
import { mimeOf } from './mime.ts';
import type { Entry } from '../../shared/types.ts';

export interface PhotoPage {
  entries: Entry[];
  /** Pass back as `before` to get the next, older page. */
  next: number | null;
  /** Total media files found in the walk. */
  total: number;
  /** The walk stopped before covering the whole location. */
  truncated: boolean;
  /** When the walk ran (the page may be a couple of minutes stale). */
  scannedAt: number;
}

interface Scan {
  at: number;
  entries: Entry[];
  truncated: boolean;
}

const TTL = 120_000;
/** How many files may have their EXIF read in one walk. */
const EXIF_BUDGET = 300;
const EXIF_MIMES = new Set(['image/jpeg', 'image/tiff', 'image/webp', 'image/png', 'image/heic', 'image/heif', 'image/avif']);

export function isMedia(mime: string): boolean {
  return (mime.startsWith('image/') && mime !== 'image/svg+xml') || mime.startsWith('video/');
}

/** The sort key of a media entry: taken when known, else modified. */
export const shotAt = (e: Entry): number => e.taken ?? e.mtime;

export class Photos {
  private readonly scans = new Map<string, Promise<Scan>>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Media under `loc`, sorted newest first; walked at most once per TTL. */
  private scan(loc: Mounted, hidden: (segments: readonly string[]) => boolean): Promise<Scan> {
    const key = loc.cfg.name;
    const cached = this.scans.get(key);
    if (cached) return cached;
    const p = walk(loc, hidden, this.db)
      .then((r) => {
        setTimeout(() => this.scans.delete(key), TTL).unref();
        return r;
      })
      .catch((e: Error) => {
        this.scans.delete(key);
        throw e;
      });
    this.scans.set(key, p);
    return p;
  }

  forget(location: string): void {
    this.scans.delete(location);
  }

  async page(loc: Mounted, hidden: (segments: readonly string[]) => boolean, before: number | null, limit: number): Promise<PhotoPage> {
    const s = await this.scan(loc, hidden);
    const start = before === null ? 0 : s.entries.findIndex((e) => shotAt(e) < before);
    const slice = start < 0 ? [] : s.entries.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const more = start >= 0 && start + limit < s.entries.length;
    return { entries: slice, next: more && last ? shotAt(last) : null, total: s.entries.length, truncated: s.truncated, scannedAt: s.at };
  }
}

async function walk(loc: Mounted, hidden: (segments: readonly string[]) => boolean, db: DatabaseSync): Promise<Scan> {
  const deadline = Date.now() + 20_000;
  const maxVisited = 250_000;
  const queue: (readonly string[])[] = [[]];
  const entries: Entry[] = [];
  let visited = 0;
  let truncated = false;
  while (queue.length) {
    if (Date.now() > deadline || visited > maxVisited) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    let children;
    try {
      children = await loc.provider.list(dir);
    } catch {
      continue;
    }
    for (const c of children) {
      if (c.name.startsWith('.')) continue;
      const segments = [...dir, c.name];
      if (hidden(segments)) continue;
      visited++;
      if (c.kind === 'dir') queue.push(segments);
      else if (isMedia(mimeOf(c.name))) entries.push(entryOf(loc.cfg.name, segments, c));
    }
  }
  await fillDates(loc, entries, db);
  entries.sort((a, b) => shotAt(b) - shotAt(a) || a.path.localeCompare(b.path));
  return { at: Date.now(), entries, truncated };
}

/** Dates taken from the cache, and for a budgeted number of new files, from the file itself. */
async function fillDates(loc: Mounted, entries: Entry[], db: DatabaseSync): Promise<void> {
  const lookup = db.prepare('SELECT taken FROM photo_dates WHERE path = ? AND etag = ?');
  const store = db.prepare('INSERT OR REPLACE INTO photo_dates (path, etag, taken) VALUES (?, ?, ?)');
  let budget = EXIF_BUDGET;
  for (const e of entries) {
    if (!EXIF_MIMES.has(e.mime)) continue;
    const hit = lookup.get(e.path, e.etag) as { taken: number | null } | undefined;
    if (hit) {
      if (hit.taken !== null) e.taken = hit.taken;
      continue;
    }
    if (budget <= 0 || !loc.provider.localPath) continue;
    budget--;
    let taken: number | null = null;
    try {
      const local = await loc.provider.localPath(e.path.split('/').slice(1));
      if (local) taken = dateTaken((await sharp(local, { limitInputPixels: 80_000_000 }).metadata()).exif);
    } catch {
      taken = null;
    }
    store.run(e.path, e.etag, taken);
    if (taken !== null) e.taken = taken;
  }
}
