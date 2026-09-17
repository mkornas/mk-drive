/**
 * Public share links. The owner creates a link to a file or folder; anyone
 * with the link (and the password, when set) can view, browse or download it
 * through `/api/s/:id/...`, which needs no account. A link dies with its
 * expiry, its owner's grant, or the owner's account.
 *
 * A folder link in `upload` mode is a file request: visitors can only add
 * files (chunked, like the account's own uploads, under `/api/s/:id/uploads`)
 * and never see what the folder holds; names that clash are kept side by side.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Access } from '../access.ts';
import type { DatabaseSync } from '../db.ts';
import type { Locations, Mounted } from '../locations.ts';
import { hashPassword, verifyPassword, type Users } from '../users.ts';
import { cookie, isSecure, type LoginThrottle, clientIp } from '../auth.ts';
import { type DrivePath, joinDrivePath, parseDrivePath } from '../paths.ts';
import { entryOf, etagOf } from '../entries.ts';
import { mimeOf } from '../mime.ts';
import { contentDisposition, fileHeaders } from '../serve-headers.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { parseRange } from './files.ts';
import { checkName, type Ops, withPolicy } from '../ops.ts';
import { appendPiece, type UploadRow, type Uploads } from './uploads.ts';
import { canThumb, THUMB_WIDTHS, type Thumbs } from '../thumbs.ts';
import type { Config } from '../config.ts';
import type { Entry, Listing, Share, ShareInfo, ShareMode, UploadStatus } from '../../../shared/types.ts';

interface ShareRow {
  id: string;
  user_id: number;
  path: string;
  kind: 'file' | 'dir';
  mode: ShareMode;
  password_hash: string | null;
  expires_at: number | null;
  created_at: number;
  hits: number;
  last_hit_at: number | null;
  uploaded_files: number;
  uploaded_bytes: number;
}

/** What one file-request link takes in over its life (pieces still on the way count by their announced size). */
export const LINK_MAX_BYTES = 10 * 1024 ** 3;
export const LINK_MAX_FILES = 1000;
/** Free space an anonymous upload must leave on the filesystem. */
export const SPACE_RESERVE = 256 * 1024 ** 2;
/** Uploads a visitor may start through one link per minute. */
export const BEGIN_PER_MINUTE = 120;

/** Fixed-window counter: at most `limit` hits per `windowMs` per key. */
export class RateLimit {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  /** Counts a hit; milliseconds to wait when over the limit, 0 when allowed. */
  take(key: string, now = Date.now()): number {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    let h = this.hits.get(key);
    if (!h || h.reset <= now) this.hits.set(key, (h = { count: 0, reset: now + this.windowMs }));
    if (h.count >= this.limit) return h.reset - now;
    h.count += 1;
    return 0;
  }
}

export function registerShareRoutes(
  app: FastifyInstance,
  cfg: Config,
  access: Access,
  locations: Locations,
  users: Users,
  ops: Ops,
  thumbs: Thumbs,
  throttle: LoginThrottle,
  db: DatabaseSync,
  uploads: Uploads,
): void {
  const secret = createHmac('sha256', 'mk-drive share cookie')
    .update(cfg.dbFile + (cfg.adminEmail || '') + String(db.prepare('SELECT MIN(created_at) AS t FROM users').get()?.t ?? ''))
    .digest();
  const unlockToken = (row: ShareRow) => createHmac('sha256', secret).update(`${row.id}|${row.password_hash}`).digest('base64url');
  const cookieName = (id: string) => `mkdrive_share_${id}`;

  const get = (id: string): ShareRow | null => (db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as unknown as ShareRow | undefined) ?? null;
  const toShare = (r: ShareRow, name: string, by: string): Share => ({
    id: r.id,
    path: r.path,
    name,
    kind: r.kind,
    mode: r.mode,
    locked: !!r.password_hash,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    createdBy: by,
    hits: r.hits,
    lastHitAt: r.last_hit_at,
  });

  /** The share's root, resolved with the *owner's* current grant (write, for a file request); dead links read as 404. */
  const root = (row: ShareRow): { loc: Mounted; dp: DrivePath } => {
    if (row.expires_at && row.expires_at < Date.now()) throw new HttpError(410, 'this link has expired');
    const owner = users.get(row.user_id);
    if (!owner || owner.disabled) throw notFound();
    const dp = parseDrivePath(row.path);
    const loc = locations.get(dp.location);
    const level = access.levelForUser(owner, loc, dp);
    if (level === 'none' || (row.mode === 'upload' && level !== 'write')) throw notFound();
    if (locations.isHidden(loc, dp.segments)) throw notFound();
    return { loc, dp };
  };

  /** A path inside the share (`rel` relative to its root), refusing escapes and hidden names. */
  const inside = (row: ShareRow, rel: string | undefined): { loc: Mounted; dp: DrivePath; rel: string[] } => {
    const base = root(row);
    if (!rel) return { ...base, rel: [] };
    const relDp = parseDrivePath(`x/${rel}`);
    // what the listing and the zip leave out is not served by name either: a visitor must not get `.env` or `.git/config` by guessing
    if (relDp.segments.some((s) => s.startsWith('.'))) throw notFound();
    const segments = [...base.dp.segments, ...relDp.segments];
    if (locations.isHidden(base.loc, segments)) throw notFound();
    return { loc: base.loc, dp: { location: base.dp.location, segments, path: joinDrivePath(base.dp.location, segments) }, rel: relDp.segments };
  };

  const isOpen = (req: FastifyRequest, row: ShareRow): boolean => !row.password_hash || cookie(req, cookieName(row.id)) === unlockToken(row);

  const mustBeOpen = (req: FastifyRequest, row: ShareRow) => {
    if (!isOpen(req, row)) throw new HttpError(401, 'this link needs a password');
  };

  const hit = (row: ShareRow) => db.prepare('UPDATE shares SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(Date.now(), row.id);

  // ---------- owner side ----------

  app.get('/api/shares', async (req): Promise<Share[]> => {
    const rows = (req.identity.role === 'admin'
      ? db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all()
      : db.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC').all(req.identity.id)) as unknown as ShareRow[];
    return rows.map((r) => toShare(r, r.path.split('/').pop() ?? r.path, users.get(r.user_id)?.email ?? '?'));
  });

  app.get<{ Querystring: { path?: string } }>('/api/shares/for', async (req): Promise<Share[]> => {
    const { dp } = access.resolve(req, req.query.path);
    const rows = db
      .prepare('SELECT * FROM shares WHERE path = ? AND (user_id = ? OR ? = 1) ORDER BY created_at DESC')
      .all(dp.path, req.identity.id, req.identity.role === 'admin' ? 1 : 0) as unknown as ShareRow[];
    return rows.map((r) => toShare(r, dp.segments[dp.segments.length - 1] ?? dp.location, users.get(r.user_id)?.email ?? '?'));
  });

  app.post<{ Body: { path?: string; expiresAt?: unknown; password?: unknown; mode?: unknown } }>('/api/shares', async (req, reply): Promise<Share> => {
    const mode: ShareMode = req.body?.mode === 'download' || req.body?.mode === 'upload' ? req.body.mode : 'browse';
    // a file request hands out the caller's write access, so it needs it
    const { loc, dp } = access.resolve(req, req.body?.path, mode === 'upload' ? 'write' : 'read');
    if (dp.segments.length === 0) throw badRequest('share a file or a folder, not a whole location');
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    if (mode === 'upload' && st.kind !== 'dir') throw badRequest('a file request needs a folder to put the files in');
    const expiresAt = req.body?.expiresAt == null ? null : Number(req.body.expiresAt);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt < Date.now())) throw badRequest('the expiry must be in the future');
    const password = typeof req.body?.password === 'string' && req.body.password ? req.body.password : null;
    if (password && password.length < 4) throw badRequest('a link password needs at least 4 characters');
    const row: ShareRow = {
      id: randomBytes(15).toString('base64url'),
      user_id: req.identity.id,
      path: dp.path,
      kind: st.kind,
      mode,
      password_hash: password ? await hashPassword(password) : null,
      expires_at: expiresAt,
      created_at: Date.now(),
      hits: 0,
      last_hit_at: null,
      uploaded_files: 0,
      uploaded_bytes: 0,
    };
    db.prepare('INSERT INTO shares (id, user_id, path, kind, mode, password_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id,
      row.user_id,
      row.path,
      row.kind,
      row.mode,
      row.password_hash,
      row.expires_at,
      row.created_at,
    );
    users.audit({
      userId: req.identity.id,
      email: req.identity.email,
      action: 'share.create',
      path: dp.path,
      detail: { id: row.id, mode, locked: !!password, expiresAt },
    });
    reply.code(201);
    return toShare(row, dp.segments[dp.segments.length - 1], req.identity.email);
  });

  app.delete<{ Params: { id: string } }>('/api/shares/:id', async (req) => {
    const row = get(req.params.id);
    if (!row || (row.user_id !== req.identity.id && req.identity.role !== 'admin')) throw notFound();
    db.prepare('DELETE FROM shares WHERE id = ?').run(row.id);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'share.delete', path: row.path, detail: { id: row.id } });
    return { ok: true };
  });

  // ---------- public side: /api/s/:id ----------

  const share = (req: FastifyRequest<{ Params: { id: string } }>): ShareRow => {
    const row = get(req.params.id);
    if (!row) throw notFound('no such link');
    return row;
  };

  app.get<{ Params: { id: string } }>('/api/s/:id', async (req): Promise<ShareInfo> => {
    const row = share(req);
    const { loc, dp } = root(row);
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    const name = dp.segments[dp.segments.length - 1];
    return {
      id: row.id,
      name,
      kind: st.kind,
      mode: row.mode,
      locked: !!row.password_hash,
      open: isOpen(req, row),
      expiresAt: row.expires_at,
      size: st.size,
      mtime: st.mtime,
      mime: st.kind === 'dir' ? '' : mimeOf(name),
    };
  });

  app.post<{ Params: { id: string }; Body: { password?: unknown } }>('/api/s/:id/unlock', async (req, reply) => {
    const row = share(req);
    root(row);
    if (!row.password_hash) return { ok: true };
    // per link and address, and a budget for the link itself so a pool of addresses guesses no faster
    const ipKey = `share:${row.id}:${clientIp(req, cfg.trustedProxies)}`;
    const linkKey = `share:${row.id}`;
    const keys = [ipKey, linkKey];
    // claimed before the check, so a concurrent burst is judged one guess at a time
    const wait = throttle.begin(keys);
    if (wait > 0) {
      reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(429, `too many attempts, wait ${Math.ceil(wait / 1000)} s`);
    }
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    const hash = row.password_hash;
    let right = false;
    try {
      right = given !== '' && (await verifyPassword(given, hash));
      if (right) throttle.succeeded(ipKey);
      else for (const k of keys) throttle.failed(k);
    } finally {
      throttle.end(keys);
    }
    if (!right) throw new HttpError(401, 'wrong password');
    const attrs = [`${cookieName(row.id)}=${unlockToken(row)}`, `Path=/api/s/${row.id}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=86400'];
    if (isSecure(req)) attrs.push('Secure');
    reply.header('Set-Cookie', attrs.join('; '));
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/s/:id/ls', async (req): Promise<Listing> => {
    const row = share(req);
    mustBeOpen(req, row);
    if (row.kind !== 'dir' || row.mode !== 'browse') throw forbidden('this link does not allow browsing');
    const { loc, dp, rel } = inside(row, req.query.path);
    const st = await loc.provider.stat(dp.segments);
    if (!st || st.kind !== 'dir') throw notFound();
    const entries: Entry[] = [];
    for (const e of await loc.provider.list(dp.segments)) {
      if (e.name.startsWith('.') || locations.isHidden(loc, [...dp.segments, e.name])) continue;
      // paths in a share listing are relative to the share root
      const entry = entryOf(dp.location, [...dp.segments, e.name], e);
      entries.push({ ...entry, path: [...rel, e.name].join('/') });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
    hit(row);
    return {
      path: rel.join('/'),
      location: row.id,
      dir: { ...entryOf(dp.location, dp.segments, st), path: rel.join('/') },
      entries,
      hiddenOmitted: false,
      access: 'read',
    };
  });

  const sendFile = async (req: FastifyRequest, reply: FastifyReply, loc: Mounted, segments: readonly string[], download: boolean) => {
    const st = await loc.provider.stat(segments);
    if (!st) throw notFound();
    if (st.kind === 'dir') throw badRequest('is a directory');
    const name = segments[segments.length - 1];
    const etag = etagOf(st);
    reply.header('ETag', etag);
    reply.header('Last-Modified', new Date(st.mtime).toUTCString());
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, no-cache');
    fileHeaders(reply, name, { disposition: download ? 'attachment' : 'inline', preview: true });
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const range = parseRange(req.headers.range, st.size);
    if (range === null) {
      reply.header('Content-Range', `bytes */${st.size}`);
      throw new HttpError(416, 'range not satisfiable');
    }
    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
      reply.header('Content-Length', String(range.end - range.start + 1));
      return reply.send(await loc.provider.read(segments, range));
    }
    reply.header('Content-Length', String(st.size));
    return reply.send(await loc.provider.read(segments));
  };

  app.get<{ Params: { id: string }; Querystring: { path?: string; download?: string } }>('/api/s/:id/file', async (req, reply) => {
    const row = share(req);
    mustBeOpen(req, row);
    const { loc, dp, rel } = inside(row, req.query.path);
    if (row.kind === 'file' && rel.length) throw notFound();
    if (row.kind === 'dir' && row.mode !== 'browse') throw forbidden('this link allows download only');
    hit(row);
    return sendFile(req, reply, loc, dp.segments, req.query.download === '1');
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; w?: string } }>('/api/s/:id/thumb', async (req, reply) => {
    const row = share(req);
    mustBeOpen(req, row);
    if (row.kind === 'dir' && row.mode !== 'browse') throw forbidden('this link allows download only');
    const { loc, dp } = inside(row, req.query.path);
    const name = dp.segments[dp.segments.length - 1] ?? '';
    if (!canThumb(mimeOf(name))) throw new HttpError(415, 'no thumbnail');
    const st = await loc.provider.stat(dp.segments);
    if (!st || st.kind !== 'file') throw notFound();
    const width = THUMB_WIDTHS.includes(Number(req.query.w)) ? Number(req.query.w) : 320;
    const key = thumbs.key(loc.cfg.name, dp.path, etagOf(st), width);
    reply.header('Content-Type', 'image/webp');
    reply.header('Cache-Control', 'private, max-age=86400');
    const { createReadStream } = await import('node:fs');
    return reply.send(createReadStream(await thumbs.get(loc.provider, dp.segments, key, width)));
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/s/:id/zip', async (req, reply) => {
    const row = share(req);
    mustBeOpen(req, row);
    if (row.kind !== 'dir') throw badRequest('not a folder');
    if (row.mode === 'upload') throw forbidden('this link only takes files in');
    const { loc, dp } = inside(row, row.mode === 'browse' ? req.query.path : undefined);
    const name = dp.segments[dp.segments.length - 1] ?? 'share';
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', contentDisposition('attachment', `${name}.zip`));
    reply.header('Cache-Control', 'private, no-store');
    hit(row);
    return reply.send(await ops.zip(loc, [dp.segments], (segments) => locations.isHidden(loc, segments) || segments.some((s) => s.startsWith('.'))));
  });

  // ---------- file requests: /api/s/:id/uploads ----------

  /** The link must be an open file request; the folder must still be there. */
  const dropbox = async (req: FastifyRequest<{ Params: { id: string } }>): Promise<{ row: ShareRow; loc: Mounted; dp: DrivePath }> => {
    const row = share(req);
    mustBeOpen(req, row);
    if (row.mode !== 'upload') throw forbidden('this link does not take files');
    const { loc, dp } = root(row);
    const st = await loc.provider.stat(dp.segments);
    if (!st || st.kind !== 'dir') throw notFound();
    return { row, loc, dp };
  };

  /** An upload started through this very link; the owner's own uploads and other links' stay out of reach. */
  const piece = (row: ShareRow, id: string): UploadRow => {
    const up = uploads.get(id);
    if (!up || up.share_id !== row.id) throw notFound('no such upload');
    return up;
  };

  // the visitor never learns what the folder holds, so `exists` is always false here
  const progress = async (loc: Mounted, up: UploadRow): Promise<UploadStatus> => ({
    id: up.id,
    path: up.dest.split('/').pop() ?? '',
    size: up.size,
    received: (await loc.provider.uploadSize(up.id)) ?? 0,
    exists: false,
  });

  const begins = new RateLimit(BEGIN_PER_MINUTE, 60_000);

  app.post<{ Params: { id: string }; Body: { name?: unknown; size?: unknown; mtime?: unknown } }>(
    '/api/s/:id/uploads',
    async (req, reply): Promise<UploadStatus> => {
      const { row, loc, dp } = await dropbox(req);
      const wait = begins.take(`${row.id}:${clientIp(req, cfg.trustedProxies)}`);
      if (wait > 0) {
        reply.header('Retry-After', String(Math.ceil(wait / 1000)));
        throw new HttpError(429, `too many uploads at once, wait ${Math.ceil(wait / 1000)} s`);
      }
      const name = checkName(req.body?.name);
      const size = Number(req.body?.size);
      if (!Number.isInteger(size) || size < 0) throw badRequest('size must be a whole number of bytes');
      if (name.startsWith('.') || locations.isHidden(loc, [...dp.segments, name])) throw badRequest('that name is reserved');
      if (size > LINK_MAX_BYTES) throw new HttpError(413, `this link takes at most ${LINK_MAX_BYTES / 1024 ** 3} GiB`);
      const space = await loc.provider.space().catch(() => null);
      if (space && size > space.free - SPACE_RESERVE) throw new HttpError(507, 'not enough free space for this file');
      // checked and recorded with no await in between, so parallel starts cannot both squeeze under the limits
      const used = db
        .prepare(
          'SELECT s.uploaded_files + COUNT(u.id) AS files, s.uploaded_bytes + COALESCE(SUM(u.size), 0) AS bytes FROM shares s LEFT JOIN uploads u ON u.share_id = s.id WHERE s.id = ?',
        )
        .get(row.id) as { files: number; bytes: number };
      if (used.files + 1 > LINK_MAX_FILES) throw new HttpError(413, `this link takes at most ${LINK_MAX_FILES} files`);
      if (used.bytes + size > LINK_MAX_BYTES) throw new HttpError(413, `this link takes at most ${LINK_MAX_BYTES / 1024 ** 3} GiB`);
      const id = randomBytes(18).toString('base64url');
      const mtime = Number(req.body?.mtime);
      uploads.create({
        id,
        user_id: row.user_id,
        location: loc.cfg.name,
        dest: joinDrivePath(dp.location, [...dp.segments, name]),
        size,
        mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : null,
        share_id: row.id,
      });
      try {
        await loc.provider.uploadBegin(id);
      } catch (e) {
        uploads.remove(id);
        throw e;
      }
      reply.code(201);
      return { id, path: name, size, received: 0, exists: false };
    },
  );

  app.get<{ Params: { id: string; uid: string } }>('/api/s/:id/uploads/:uid', async (req): Promise<UploadStatus> => {
    const { row, loc } = await dropbox(req);
    return progress(loc, piece(row, req.params.uid));
  });

  app.patch<{ Params: { id: string; uid: string } }>('/api/s/:id/uploads/:uid', async (req): Promise<UploadStatus> => {
    const { row, loc } = await dropbox(req);
    const up = piece(row, req.params.uid);
    await appendPiece(req, loc, up, uploads);
    return progress(loc, up);
  });

  app.post<{ Params: { id: string; uid: string } }>('/api/s/:id/uploads/:uid/complete', async (req): Promise<{ ok: true; name: string }> => {
    const { row, loc, dp } = await dropbox(req);
    const up = piece(row, req.params.uid);
    const received = (await loc.provider.uploadSize(up.id)) ?? 0;
    if (received !== up.size) throw badRequest(`upload incomplete: ${received} of ${up.size} bytes`);
    const name = up.dest.split('/').pop() ?? '';
    // a visitor never replaces anything: a taken name gets a numbered sibling
    const final = await withPolicy(
      name,
      'rename',
      async (n) => (await loc.provider.stat([...dp.segments, n])) !== null,
      (n, replace) => loc.provider.uploadCommit(up.id, [...dp.segments, n], { replace, mtime: up.mtime ?? undefined }),
    );
    uploads.remove(up.id);
    db.prepare('UPDATE shares SET uploaded_files = uploaded_files + 1, uploaded_bytes = uploaded_bytes + ? WHERE id = ?').run(up.size, row.id);
    hit(row);
    const owner = users.get(row.user_id);
    users.audit({
      userId: row.user_id,
      email: owner?.email ?? '?',
      action: 'upload',
      path: joinDrivePath(dp.location, [...dp.segments, final]),
      detail: { size: up.size, link: row.id },
    });
    return { ok: true, name: final };
  });

  app.delete<{ Params: { id: string; uid: string } }>('/api/s/:id/uploads/:uid', async (req) => {
    const { row, loc } = await dropbox(req);
    const up = piece(row, req.params.uid);
    await loc.provider.uploadAbort(up.id);
    uploads.remove(up.id);
    return { ok: true };
  });
}
