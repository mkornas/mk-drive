/**
 * Chunked, resumable uploads: begin → PATCH pieces at increasing offsets →
 * complete. Pieces are raw `application/octet-stream` bodies of at most
 * `CHUNK_MAX` bytes (well under Cloudflare's 100 MB request cap).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import type { Access } from '../access.ts';
import type { Locations, Mounted } from '../locations.ts';
import type { DatabaseSync } from '../db.ts';
import { checkName, parsePolicy, withPolicy } from '../ops.ts';
import { OffsetError } from '../storage/local.ts';
import type { Users } from '../users.ts';
import { joinDrivePath, parseDrivePath } from '../paths.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import type { UploadStatus } from '../../../shared/types.ts';

export const CHUNK_MAX = 64 * 1024 * 1024;
const STALE_MS = 24 * 3_600_000;

export interface UploadRow {
  id: string;
  user_id: number;
  location: string;
  dest: string;
  size: number;
  mtime: number | null;
  /** Set when a visitor started it through a file-request link (`/api/s/:id/uploads`); such rows are not the owner's to touch. */
  share_id: string | null;
  created_at: number;
  updated_at: number;
}

export class Uploads {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  get(id: string): UploadRow | null {
    return (this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as unknown as UploadRow | undefined) ?? null;
  }
  create(row: Omit<UploadRow, 'created_at' | 'updated_at' | 'share_id'> & { share_id?: string }): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO uploads (id, user_id, location, dest, size, mtime, share_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.location, row.dest, row.size, row.mtime, row.share_id ?? null, now, now);
  }
  touch(id: string): void {
    this.db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
  remove(id: string): void {
    this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  }
  stale(): UploadRow[] {
    return this.db.prepare('SELECT * FROM uploads WHERE updated_at < ?').all(Date.now() - STALE_MS) as unknown as UploadRow[];
  }
}

export function registerUploadRoutes(app: FastifyInstance, access: Access, locations: Locations, users: Users, uploads: Uploads): void {
  // raw bodies for the pieces: the stream itself becomes `req.body`
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  const own = (req: FastifyRequest, id: string): UploadRow => {
    const row = uploads.get(id);
    if (!row || row.share_id || (row.user_id !== req.identity.id && req.identity.role !== 'admin')) throw notFound('no such upload');
    return row;
  };

  const status = async (req: FastifyRequest, row: UploadRow): Promise<UploadStatus> => {
    const { loc, dp } = access.resolve(req, row.dest, 'write');
    const received = (await loc.provider.uploadSize(row.id)) ?? 0;
    return { id: row.id, path: row.dest, size: row.size, received, exists: (await loc.provider.stat(dp.segments)) !== null };
  };

  app.post<{ Body: { dir?: string; name?: unknown; size?: unknown; mtime?: unknown } }>('/api/uploads', async (req, reply): Promise<UploadStatus> => {
    const { loc, dp } = access.resolve(req, req.body?.dir, 'write');
    const name = checkName(req.body?.name);
    const size = Number(req.body?.size);
    if (!Number.isInteger(size) || size < 0) throw badRequest('size must be a whole number of bytes');
    if (locations.isHidden(loc, [...dp.segments, name])) throw badRequest('that name is reserved');
    const st = await loc.provider.stat(dp.segments);
    if (!st || st.kind !== 'dir') throw notFound();
    const id = randomBytes(18).toString('base64url');
    await loc.provider.uploadBegin(id);
    const mtime = Number(req.body?.mtime);
    uploads.create({
      id,
      user_id: req.identity.id,
      location: loc.cfg.name,
      dest: joinDrivePath(dp.location, [...dp.segments, name]),
      size,
      mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : null,
    });
    reply.code(201);
    return {
      id,
      path: joinDrivePath(dp.location, [...dp.segments, name]),
      size,
      received: 0,
      exists: (await loc.provider.stat([...dp.segments, name])) !== null,
    };
  });

  app.get<{ Params: { id: string } }>('/api/uploads/:id', async (req): Promise<UploadStatus> => status(req, own(req, req.params.id)));

  app.patch<{ Params: { id: string } }>('/api/uploads/:id', async (req): Promise<UploadStatus> => {
    const row = own(req, req.params.id);
    const { loc } = access.resolve(req, row.dest, 'write');
    const offset = Number(req.headers['upload-offset']);
    await appendPiece(req, loc, row, uploads);
    return status(req, row);
  });

  app.post<{ Params: { id: string }; Body: { onConflict?: unknown } }>('/api/uploads/:id/complete', async (req) => {
    const row = own(req, req.params.id);
    const { loc, dp } = access.resolve(req, row.dest, 'write');
    const received = (await loc.provider.uploadSize(row.id)) ?? 0;
    if (received !== row.size) throw badRequest(`upload incomplete: ${received} of ${row.size} bytes`);
    const dir = dp.segments.slice(0, -1);
    const name = dp.segments[dp.segments.length - 1];
    const final = await withPolicy(
      name,
      parsePolicy(req.body?.onConflict),
      async (n) => (await loc.provider.stat([...dir, n])) !== null,
      (n, replace) => loc.provider.uploadCommit(row.id, [...dir, n], { replace, mtime: row.mtime ?? undefined }),
    );
    uploads.remove(row.id);
    const path = joinDrivePath(dp.location, [...dir, final]);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'upload', path, detail: { size: row.size } });
    return { ok: true, path };
  });

  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async (req) => {
    const row = own(req, req.params.id);
    const { loc } = access.resolve(req, row.dest, 'write');
    await loc.provider.uploadAbort(row.id);
    uploads.remove(row.id);
    return { ok: true };
  });
}

/**
 * One piece of an upload: `Upload-Offset` says where it goes; the provider refuses a gap or an overlap. Shared with the file-request routes.
 * The piece must say its `Content-Length`; nothing past that many bytes is written, and a longer body fails (413).
 */
export async function appendPiece(req: FastifyRequest, loc: Mounted, row: UploadRow, uploads: Uploads): Promise<void> {
  const offset = Number(req.headers['upload-offset']);
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('Upload-Offset header is required');
  const raw = req.headers['content-length'];
  if (raw === undefined) throw new HttpError(411, 'a piece needs a Content-Length');
  const len = Number(raw);
  if (!Number.isInteger(len) || len < 0) throw badRequest('bad Content-Length');
  if (len > CHUNK_MAX) throw new HttpError(413, `a piece may be at most ${CHUNK_MAX} bytes`);
  if (offset + len > row.size) throw badRequest('more bytes than announced');
  try {
    await loc.provider.uploadAppend(row.id, offset, Readable.from(atMost(req.body as Readable, len)));
  } catch (e) {
    if (e instanceof OffsetError) {
      throw new HttpError(409, `offset mismatch: ${e.received} bytes received`);
    }
    throw e;
  }
  uploads.touch(row.id);
}

/**
 * Passes bytes on up to `max`; anything past it is counted and dropped, and the stream then fails (413).
 * The rest is read out rather than the request torn down, so the caller still gets the answer.
 */
export async function* atMost(source: AsyncIterable<Buffer>, max: number): AsyncGenerator<Buffer> {
  let seen = 0;
  for await (const chunk of source) {
    if (seen + chunk.length <= max) yield chunk;
    else if (seen < max) yield chunk.subarray(0, max - seen);
    seen += chunk.length;
  }
  if (seen > max) throw new HttpError(413, `more than the ${max} bytes this piece announced`);
}

/** Drop parts nobody touched for a day (crashed browsers, closed laptops). */
export async function sweepStaleUploads(uploads: Uploads, locations: Locations): Promise<number> {
  let n = 0;
  for (const row of uploads.stale()) {
    try {
      const loc = locations.get(parseDrivePath(row.dest).location);
      await loc.provider.uploadAbort(row.id);
    } catch {
      /* location gone: forget the record anyway */
    }
    uploads.remove(row.id);
    n++;
  }
  return n;
}
