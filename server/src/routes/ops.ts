import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Access } from '../access.ts';
import type { Locations } from '../locations.ts';
import { checkName, Ops, parsePolicy } from '../ops.ts';
import type { Users } from '../users.ts';
import { joinDrivePath, parseDrivePath } from '../paths.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import type { ConflictPolicy, OpResult, TrashEntry } from '../../../shared/types.ts';

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function paths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500 || raw.some((p) => typeof p !== 'string')) throw badRequest('paths must be a non-empty list');
  return raw as string[];
}

/** Folders, rename, move, copy, trash, zip. Every path is checked for a write grant where it matters. */
export function registerOpRoutes(app: FastifyInstance, access: Access, locations: Locations, users: Users, ops: Ops): void {
  const audit = (req: FastifyRequest, action: string, path: string, detail?: unknown) => users.audit({ userId: req.identity.id, email: req.identity.email, action, path, detail });

  /** Run one operation per path, turning known failures into per-item results. */
  const each = async (raw: string[], fn: (p: string) => Promise<string>): Promise<OpResult[]> => {
    const out: OpResult[] = [];
    for (const from of raw) {
      try {
        out.push({ from, to: await fn(from), ok: true });
      } catch (e) {
        const err = e as HttpError;
        const status = err.statusCode ?? 500;
        out.push({ from, ok: false, error: status >= 500 ? 'failed' : err.message, code: status === 409 ? 'exists' : status === 403 ? 'forbidden' : status === 404 ? 'notfound' : 'error' });
        if (status >= 500) req_log?.error(err);
      }
    }
    return out;
  };
  let req_log: FastifyRequest['log'] | undefined;

  app.post<{ Body: { path?: string; name?: unknown; onConflict?: unknown } }>('/api/mkdir', async (req) => {
    const { loc, dp } = access.resolve(req, req.body?.path, 'write');
    const name = checkName(req.body?.name);
    if (locations.isHidden(loc, [...dp.segments, name])) throw badRequest('that name is reserved');
    const st = await loc.provider.stat(dp.segments);
    if (!st || st.kind !== 'dir') throw notFound();
    const final = await ops.mkdir(loc, dp.segments, name, parsePolicy(req.body?.onConflict));
    const path = joinDrivePath(dp.location, [...dp.segments, final]);
    audit(req, 'mkdir', path);
    return { ok: true, path };
  });

  app.post<{ Body: { path?: string; name?: unknown; onConflict?: unknown } }>('/api/rename', async (req) => {
    const { loc, dp } = access.resolve(req, req.body?.path, 'write');
    if (dp.segments.length === 0) throw badRequest('cannot rename a location');
    const name = checkName(req.body?.name);
    if (locations.isHidden(loc, [...dp.segments.slice(0, -1), name])) throw badRequest('that name is reserved');
    if (!(await loc.provider.stat(dp.segments))) throw notFound();
    const final = await ops.rename(loc, dp.segments, name, parsePolicy(req.body?.onConflict));
    const path = joinDrivePath(dp.location, [...dp.segments.slice(0, -1), final]);
    audit(req, 'rename', dp.path, { to: path });
    return { ok: true, path };
  });

  const moveOrCopy = (kind: 'move' | 'copy') => async (req: FastifyRequest<{ Body: { paths?: unknown; to?: string; onConflict?: unknown } }>): Promise<OpResult[]> => {
    req_log = req.log;
    const target = access.resolve(req, req.body?.to, 'write');
    const tst = await target.loc.provider.stat(target.dp.segments);
    if (!tst || tst.kind !== 'dir') throw badRequest('destination is not a folder');
    const policy: ConflictPolicy = parsePolicy(req.body?.onConflict);
    return each(paths(req.body?.paths), async (raw) => {
      const src = access.resolve(req, raw, kind === 'move' ? 'write' : 'read');
      if (src.dp.segments.length === 0) throw badRequest('cannot move a location');
      const final = kind === 'move' ? await ops.move(src.loc, src.dp.segments, target.loc, target.dp.segments, policy) : await ops.copy(src.loc, src.dp.segments, target.loc, target.dp.segments, policy);
      const to = joinDrivePath(target.dp.location, [...target.dp.segments, final]);
      audit(req, kind, src.dp.path, { to });
      return to;
    });
  };
  app.post('/api/move', moveOrCopy('move'));
  app.post('/api/copy', moveOrCopy('copy'));

  app.post<{ Body: { paths?: unknown } }>('/api/delete', async (req): Promise<OpResult[]> => {
    req_log = req.log;
    return each(paths(req.body?.paths), async (raw) => {
      const { loc, dp } = access.resolve(req, raw, 'write');
      if (dp.segments.length === 0) throw badRequest('cannot delete a location');
      const entry = await ops.trash(loc, dp.segments, req.identity);
      audit(req, 'delete', dp.path, { trash: entry.id });
      return entry.id;
    });
  });

  app.get<{ Querystring: { location?: string } }>('/api/trash', async (req): Promise<TrashEntry[]> => {
    const { loc } = access.resolve(req, req.query.location, 'write');
    return ops.trashList(loc.cfg.name);
  });

  const trashEntry = (req: FastifyRequest, id: string) => {
    const entry = ops.trashGet(id);
    if (!entry) throw notFound();
    const { loc } = access.resolve(req, entry.location, 'write');
    return { loc, entry };
  };

  app.post<{ Params: { id: string }; Body: { onConflict?: unknown } }>('/api/trash/:id/restore', async (req) => {
    const { loc, entry } = trashEntry(req, req.params.id);
    const path = await ops.restore(loc, entry, parsePolicy(req.body?.onConflict));
    audit(req, 'restore', path, { trash: entry.id });
    return { ok: true, path };
  });

  app.delete<{ Params: { id: string } }>('/api/trash/:id', async (req) => {
    const { loc, entry } = trashEntry(req, req.params.id);
    await ops.purge(loc, entry);
    audit(req, 'purge', entry.original);
    return { ok: true };
  });

  app.post<{ Body: { location?: string } }>('/api/trash/empty', async (req) => {
    const { loc } = access.resolve(req, req.body?.location, 'write');
    const entries = ops.trashList(loc.cfg.name);
    for (const e of entries) await ops.purge(loc, e);
    audit(req, 'trash.empty', loc.cfg.name, { count: entries.length });
    return { ok: true, count: entries.length };
  });

  app.get<{ Querystring: { path?: string | string[] } }>('/api/zip', async (req, reply) => {
    const raw = Array.isArray(req.query.path) ? req.query.path : req.query.path ? [req.query.path] : [];
    if (raw.length === 0 || raw.length > 500) throw badRequest('path is required');
    const items = raw.map((p) => access.resolve(req, p));
    const loc = items[0].loc;
    if (items.some((i) => i.loc !== loc)) throw badRequest('one location per zip');
    const first = items[0].dp;
    const name = items.length === 1 ? (first.segments[first.segments.length - 1] ?? loc.cfg.name) : (first.segments.length > 1 ? first.segments[first.segments.length - 2] : loc.cfg.name);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', contentDisposition(`${name}.zip`));
    reply.header('Cache-Control', 'private, no-store');
    audit(req, 'zip', joinDrivePath(loc.cfg.name, first.segments.slice(0, -1)), { count: items.length });
    return reply.send(await ops.zip(loc, items.map((i) => i.dp.segments), (segments) => locations.isHidden(loc, segments)));
  });
}
