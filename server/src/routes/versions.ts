/** Earlier copies of a file from filesystem snapshots (ZFS `.zfs/snapshot`), and restoring one. */
import type { FastifyInstance } from 'fastify';
import type { Access } from '../access.ts';
import type { Users } from '../users.ts';
import { parsePolicy, withPolicy } from '../ops.ts';
import { badRequest, notFound } from '../errors.ts';
import { fileHeaders } from '../serve-headers.ts';
import { joinDrivePath } from '../paths.ts';
import type { Version } from '../../../shared/types.ts';

/** `auto-drive-2026-09-11_03-30` → epoch ms of that local time; 0 when the name carries no date. */
export function snapshotTime(name: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[_T-](\d{2})[-:](\d{2})/.exec(name);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

export function registerVersionRoutes(app: FastifyInstance, access: Access, users: Users): void {
  app.get<{ Querystring: { path?: string } }>('/api/versions', async (req): Promise<Version[]> => {
    const { loc, dp } = access.resolve(req, req.query.path);
    if (dp.segments.length === 0) return [];
    const current = await loc.provider.stat(dp.segments);
    const list = await loc.provider.versions(dp.segments);
    // only versions that differ from the current file, and from each other, are worth showing
    const seen = new Set<string>();
    if (current) seen.add(`${current.size}-${current.mtime}`);
    const out: Version[] = [];
    for (const v of list) {
      const key = `${v.stat.size}-${v.stat.mtime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ snapshot: v.snapshot, at: snapshotTime(v.snapshot), size: v.stat.size, mtime: v.stat.mtime });
    }
    return out;
  });

  app.get<{ Querystring: { path?: string; snapshot?: string; download?: string } }>('/api/versions/file', async (req, reply) => {
    const { loc, dp } = access.resolve(req, req.query.path);
    const snapshot = req.query.snapshot ?? '';
    if (!snapshot) throw badRequest('snapshot is required');
    const name = dp.segments[dp.segments.length - 1] ?? '';
    let stream;
    try {
      stream = await loc.provider.readVersion(snapshot, dp.segments);
    } catch {
      throw notFound('no such version');
    }
    reply.header('Cache-Control', 'private, no-cache');
    fileHeaders(reply, name, { disposition: req.query.download === '1' ? 'attachment' : 'inline' });
    return reply.send(stream);
  });

  app.post<{ Body: { path?: string; snapshot?: unknown; onConflict?: unknown } }>('/api/versions/restore', async (req) => {
    const { loc, dp } = access.resolve(req, req.body?.path, 'write');
    const snapshot = typeof req.body?.snapshot === 'string' ? req.body.snapshot : '';
    if (!snapshot || dp.segments.length === 0) throw badRequest('path and snapshot are required');
    const dir = dp.segments.slice(0, -1);
    const name = dp.segments[dp.segments.length - 1];
    const policy = parsePolicy(req.body?.onConflict);
    const final = await withPolicy(
      name,
      policy === 'fail' ? 'rename' : policy,
      async (n) => (await loc.provider.stat([...dir, n])) !== null,
      async (n, replace) => {
        let stream;
        try {
          stream = await loc.provider.readVersion(snapshot, dp.segments);
        } catch {
          throw notFound('no such version');
        }
        await loc.provider.write([...dir, n], stream, { replace });
      },
    );
    const path = joinDrivePath(dp.location, [...dir, final]);
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'restore.version', path, detail: { snapshot, from: dp.path } });
    return { ok: true, path };
  });
}
