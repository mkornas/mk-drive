import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Access, Resolved } from '../access.ts';
import type { Locations } from '../locations.ts';
import { isText, mimeOf } from '../mime.ts';
import { fileHeaders } from '../serve-headers.ts';
import { entryOf, etagOf } from '../entries.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import type { StorageStat } from '../storage/provider.ts';
import { Readable } from 'node:stream';
import { grantLevel, type Users } from '../users.ts';
import type { Entry, Listing, Location } from '../../../shared/types.ts';

/** `bytes=a-b` → inclusive range; `undefined` = no/ignored header; `null` = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (size === 0) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

/** Browsing routes: locations, listings, file streaming. Every path is checked against the caller's grant. */
export function registerFileRoutes(app: FastifyInstance, access: Access, locations: Locations, users: Users): void {
  const resolve = (req: FastifyRequest, raw: string | undefined, need: 'read' | 'write' = 'read'): Resolved => access.resolve(req, raw, need);

  app.get('/api/locations', async (req): Promise<Location[]> => {
    const user = users.get(req.identity.id);
    if (!user || user.disabled) throw forbidden('account disabled');
    return locations.describe(req.identity, (name) => grantLevel(user, name));
  });

  app.get<{ Querystring: { path?: string; hidden?: string; dirs?: string } }>('/api/ls', async (req): Promise<Listing> => {
    const { loc, dp, access } = resolve(req, req.query.path);
    const showHidden = req.query.hidden === '1' || req.query.hidden === 'true';
    const dirsOnly = req.query.dirs === '1' || req.query.dirs === 'true';
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    if (st.kind !== 'dir') throw badRequest('not a directory');
    const raw = await loc.provider.list(dp.segments, { dirsOnly });
    let hiddenOmitted = false;
    const entries: Entry[] = [];
    for (const e of raw) {
      if (locations.isHidden(loc, [...dp.segments, e.name])) continue;
      if (!showHidden && e.name.startsWith('.')) {
        hiddenOmitted = true;
        continue;
      }
      entries.push(entryOf(dp.location, [...dp.segments, e.name], e));
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
    if (dirsOnly) {
      // The folder tree asks this way: say which folders have subfolders, so leaves get no chevron.
      // One cheap readdir per child, a few at a time (network filesystems like it bounded).
      const dirs = entries.filter((e) => e.kind === 'dir');
      let next = 0;
      const worker = async () => {
        while (next < dirs.length) {
          const e = dirs[next++];
          const segs = [...dp.segments, e.name];
          const kids = await loc.provider.list(segs, { dirsOnly: true }).catch(() => []);
          e.hasDirs = kids.some((k) => k.kind === 'dir' && (showHidden || !k.name.startsWith('.')) && !locations.isHidden(loc, [...segs, k.name]));
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, dirs.length) }, worker));
    }
    return { path: dp.path, location: dp.location, dir: entryOf(dp.location, dp.segments, st), entries, hiddenOmitted, access };
  });

  /** Save an edited text file: the body replaces it, `If-Match` must carry the ETag the editor opened (412 otherwise). */
  app.put<{ Querystring: { path?: string } }>('/api/file', async (req, reply): Promise<Entry> => {
    const { loc, dp } = resolve(req, req.query.path, 'write');
    if (dp.segments.length === 0) throw badRequest('not a file');
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    if (st.kind !== 'file') throw badRequest('is a directory');
    const name = dp.segments[dp.segments.length - 1];
    if (!isText(mimeOf(name))) throw new HttpError(415, 'only text files can be edited here');
    const expected = req.headers['if-match'];
    if (typeof expected !== 'string') throw new HttpError(428, 'If-Match with the ETag you opened is required');
    if (expected !== etagOf(st)) throw new HttpError(412, 'the file changed since you opened it — reload and edit again');
    const body =
      req.body instanceof Readable
        ? req.body
        : Readable.from([
            typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? '')),
          ]);
    await loc.provider.write(dp.segments, body, { replace: true });
    const after = await loc.provider.stat(dp.segments);
    if (!after) throw notFound();
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'edit', path: dp.path, detail: { size: after.size } });
    reply.header('ETag', etagOf(after));
    return entryOf(dp.location, dp.segments, after);
  });

  app.get<{ Querystring: { path?: string; download?: string } }>('/api/file', async (req, reply) => {
    const { loc, dp } = resolve(req, req.query.path);
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    if (st.kind === 'dir') throw badRequest('is a directory');
    const name = dp.segments[dp.segments.length - 1] ?? dp.location;
    const etag = etagOf(st);
    const download = req.query.download === '1' || req.query.download === 'true';

    reply.header('ETag', etag);
    reply.header('Last-Modified', new Date(st.mtime).toUTCString());
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, no-cache');
    fileHeaders(reply, name, { disposition: download ? 'attachment' : 'inline', preview: true });

    if (req.headers['if-none-match'] === etag) return reply.code(304).send();

    const ifRange = req.headers['if-range'];
    const range = ifRange && ifRange !== etag ? undefined : parseRange(req.headers.range, st.size);
    if (range === null) {
      reply.header('Content-Range', `bytes */${st.size}`);
      throw new HttpError(416, 'range not satisfiable');
    }
    if (req.method === 'HEAD') {
      reply.header('Content-Length', String(st.size));
      return reply.send();
    }
    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
      reply.header('Content-Length', String(range.end - range.start + 1));
      return reply.send(await loc.provider.read(dp.segments, range));
    }
    reply.header('Content-Length', String(st.size));
    return reply.send(await loc.provider.read(dp.segments));
  });
}
