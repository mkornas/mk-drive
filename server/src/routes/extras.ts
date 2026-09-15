/** Thumbnails, search, stars and recent files. */
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Access } from '../access.ts';
import type { DatabaseSync } from '../db.ts';
import type { Locations, Mounted } from '../locations.ts';
import { canThumb, THUMB_WIDTHS, type Thumbs } from '../thumbs.ts';
import { searchContent, searchNames, type SearchResult } from '../search.ts';
import { folderStats } from '../du.ts';
import { entryOf, etagOf } from '../entries.ts';
import { mimeOf } from '../mime.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import type { Arrival, Entry, FolderStats } from '../../../shared/types.ts';
import type { Users } from '../users.ts';
import { Photos } from '../photos.ts';
import type { PhotoPage } from '../../../shared/types.ts';

export function registerExtraRoutes(app: FastifyInstance, access: Access, locations: Locations, thumbs: Thumbs, db: DatabaseSync, users: Users): void {
  app.get<{ Querystring: { path?: string; w?: string } }>('/api/thumb', async (req, reply) => {
    const { loc, dp } = access.resolve(req, req.query.path);
    const width = THUMB_WIDTHS.includes(Number(req.query.w)) ? Number(req.query.w) : 320;
    const name = dp.segments[dp.segments.length - 1] ?? '';
    const mime = mimeOf(name);
    if (!canThumb(mime)) throw new HttpError(415, 'no thumbnail for this type');
    const st = await loc.provider.stat(dp.segments);
    if (!st || st.kind !== 'file') throw notFound();
    const key = thumbs.key(loc.cfg.name, dp.path, etagOf(st), width);
    const tag = `"${key}"`;
    reply.header('ETag', tag);
    reply.header('Cache-Control', 'private, max-age=86400');
    if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    let file: string;
    try {
      file = await thumbs.get(loc.provider, dp.segments, key, width, mime);
    } catch (e) {
      req.log.warn(`thumbnail failed for ${dp.path}: ${(e as Error).message}`);
      throw new HttpError(415, 'could not render a thumbnail');
    }
    reply.header('Content-Type', 'image/webp');
    return reply.send(createReadStream(file));
  });

  const photos = new Photos(db);
  app.get<{ Querystring: { location?: string; before?: string; limit?: string; fresh?: string } }>('/api/photos', async (req): Promise<PhotoPage> => {
    const { loc, dp } = access.resolve(req, req.query.location);
    if (dp.segments.length) throw badRequest('location only');
    if (req.query.fresh === '1') photos.forget(loc.cfg.name); // walk again now instead of after the cache's two minutes
    const before = req.query.before ? Number(req.query.before) : null;
    if (before !== null && !Number.isFinite(before)) throw badRequest('bad cursor');
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    return photos.page(loc, (s) => locations.isHidden(loc, s), before, limit);
  });

  // `in=content` looks inside text files and PDFs instead of at names; both are bounded walks, never an index.
  // Without `path` the search covers every location the caller may open, the time budget shared between them.
  app.get<{ Querystring: { path?: string; q?: string; hidden?: string; limit?: string; in?: string } }>('/api/search', async (req): Promise<SearchResult> => {
    const q = (req.query.q ?? '').trim();
    if (q.length < 1) throw badRequest('q is required');
    const content = req.query.in === 'content';
    if (content && q.length < 2) throw badRequest('type at least two characters to search inside files');
    const limit = content ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const showDotfiles = req.query.hidden === '1';
    const roots: { loc: Mounted; start: readonly string[] }[] = [];
    if (req.query.path) {
      const { loc, dp } = access.resolve(req, req.query.path);
      roots.push({ loc, start: dp.segments });
    } else {
      for (const name of locations.names) {
        const loc = locations.get(name);
        if (access.levelOf(req, loc) !== 'none') roots.push({ loc, start: [] }); // an unmounted one just lists nothing
      }
    }
    const budgetMs = Math.max(content ? 2500 : 1000, (content ? 10_000 : 4000) / Math.max(1, roots.length));
    const parts = await Promise.all(
      roots.map(({ loc, start }) => {
        const opts = { hidden: (s: readonly string[]) => locations.isHidden(loc, s), showDotfiles, limit, budgetMs };
        return content ? searchContent(loc, start, q, opts) : searchNames(loc, start, q, opts);
      }),
    );
    const merged: SearchResult = { entries: parts.flatMap((p) => p.entries).slice(0, limit), truncated: parts.some((p) => p.truncated), visited: parts.reduce((n, p) => n + p.visited, 0) };
    if (content) merged.scanned = parts.reduce((n, p) => n + (p.scanned ?? 0), 0);
    return merged;
  });

  // ---- stars & recent: paths per user; entries are re-checked against the filesystem and the grant on read ----
  const resolveEntries = async (req: FastifyRequest, rows: { path: string; at: number }[]): Promise<(Entry & { at: number })[]> => {
    const out: (Entry & { at: number })[] = [];
    for (const row of rows) {
      try {
        const { loc, dp } = access.resolve(req, row.path);
        const st = await loc.provider.stat(dp.segments);
        if (st) out.push({ ...entryOf(dp.location, dp.segments, st), at: row.at });
      } catch {
        /* gone or no longer allowed */
      }
    }
    return out;
  };

  app.get('/api/stars', async (req) => resolveEntries(req, db.prepare('SELECT path, at FROM stars WHERE user_id = ? ORDER BY at DESC').all(req.identity.id) as unknown as { path: string; at: number }[]));

  app.post<{ Body: { path?: string } }>('/api/stars', async (req) => {
    const { dp } = access.resolve(req, req.body?.path);
    db.prepare('INSERT OR REPLACE INTO stars (user_id, path, at) VALUES (?, ?, ?)').run(req.identity.id, dp.path, Date.now());
    return { ok: true };
  });

  app.delete<{ Querystring: { path?: string } }>('/api/stars', async (req) => {
    const { dp } = access.resolve(req, req.query.path);
    db.prepare('DELETE FROM stars WHERE user_id = ? AND path = ?').run(req.identity.id, dp.path);
    return { ok: true };
  });

  // ---- folder details: a bounded walk, never an index ----
  app.get<{ Querystring: { path?: string; hidden?: string } }>('/api/du', async (req): Promise<FolderStats> => {
    const { loc, dp } = access.resolve(req, req.query.path);
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    if (st.kind !== 'dir') throw badRequest('not a folder');
    return folderStats(loc, dp.segments, { hidden: (s) => locations.isHidden(loc, s), showDotfiles: req.query.hidden === '1' });
  });

  // ---- arrivals: the newest uploads the caller may see, read off the audit log (no index of the files themselves) ----
  app.get<{ Querystring: { limit?: string } }>('/api/arrivals', async (req): Promise<Arrival[]> => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = db.prepare("SELECT at, user_id, email, path, detail FROM audit WHERE action = 'upload' ORDER BY id DESC LIMIT 400").all() as unknown as { at: number; user_id: number | null; email: string; path: string; detail: string }[];
    const out: Arrival[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (out.length >= limit) break;
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      try {
        const { loc, dp } = access.resolve(req, row.path);
        const st = await loc.provider.stat(dp.segments);
        if (!st || st.kind !== 'file') continue;
        const by = row.user_id ? users.get(row.user_id) : null;
        let viaLink = false;
        try {
          viaLink = typeof JSON.parse(row.detail || '{}').link === 'string';
        } catch {
          /* old rows: plain text detail */
        }
        out.push({ ...entryOf(dp.location, dp.segments, st), at: row.at, by: { email: row.email, name: by?.name ?? row.email }, viaLink });
      } catch {
        /* gone, or not the caller's to see */
      }
    }
    return out;
  });

  app.get('/api/recent', async (req) => resolveEntries(req, db.prepare('SELECT path, at FROM recent WHERE user_id = ? ORDER BY at DESC LIMIT 50').all(req.identity.id) as unknown as { path: string; at: number }[]));

  app.post<{ Body: { path?: string } }>('/api/recent', async (req) => {
    const { dp } = access.resolve(req, req.body?.path);
    db.prepare('INSERT OR REPLACE INTO recent (user_id, path, at) VALUES (?, ?, ?)').run(req.identity.id, dp.path, Date.now());
    db.prepare('DELETE FROM recent WHERE user_id = ? AND path NOT IN (SELECT path FROM recent WHERE user_id = ? ORDER BY at DESC LIMIT 50)').run(req.identity.id, req.identity.id);
    return { ok: true };
  });

  app.delete('/api/recent', async (req) => {
    db.prepare('DELETE FROM recent WHERE user_id = ?').run(req.identity.id);
    return { ok: true };
  });
}
