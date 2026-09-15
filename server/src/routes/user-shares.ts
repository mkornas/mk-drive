/**
 * Sharing a folder or a file with another account. The owner's grant,
 * narrowed to one path and handed to someone who has no (or less) access to
 * the location; `Access.levelForUser()` honours it on every route. Nothing
 * here is public: the recipient signs in like anyone else and finds it under
 * "Shared with me".
 */
import type { FastifyInstance } from 'fastify';
import type { Access } from '../access.ts';
import type { DatabaseSync } from '../db.ts';
import type { Locations } from '../locations.ts';
import { grantLevel, type Users } from '../users.ts';
import { parseDrivePath } from '../paths.ts';
import { mimeOf } from '../mime.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import type { AccessLevel, User, UserShare } from '../../../shared/types.ts';

interface Row {
  id: number;
  owner_id: number;
  user_id: number;
  path: string;
  level: 'read' | 'write';
  created_at: number;
}

export function registerUserShareRoutes(app: FastifyInstance, access: Access, locations: Locations, users: Users, db: DatabaseSync): void {
  const who = (u: User | null) => (u ? { id: u.id, email: u.email, name: u.name } : { id: 0, email: '?', name: '?' });
  const toShare = (r: Row): UserShare => ({
    id: r.id,
    path: r.path,
    name: r.path.split('/').pop() ?? r.path,
    level: r.level,
    user: who(users.get(r.user_id)),
    owner: who(users.get(r.owner_id)),
    createdAt: r.created_at,
  });
  const get = (id: number): Row | null => (db.prepare('SELECT * FROM user_shares WHERE id = ?').get(id) as unknown as Row | undefined) ?? null;

  /** Shares on one path, seen by its owner (or an admin). */
  app.get<{ Querystring: { path?: string } }>('/api/user-shares', async (req): Promise<UserShare[]> => {
    const { dp } = access.resolve(req, req.query.path);
    const rows = db
      .prepare('SELECT * FROM user_shares WHERE path = ? AND (owner_id = ? OR ? = 1) ORDER BY created_at')
      .all(dp.path, req.identity.id, req.identity.role === 'admin' ? 1 : 0) as unknown as Row[];
    return rows.map(toShare);
  });

  app.post<{ Body: { path?: string; email?: unknown; level?: unknown } }>('/api/user-shares', async (req, reply): Promise<UserShare> => {
    const level: AccessLevel = req.body?.level === 'write' ? 'write' : 'read';
    // you can only hand out what you have yourself, here and now
    const { loc, dp } = access.resolve(req, req.body?.path, level);
    if (dp.segments.length === 0) throw badRequest('share a folder or a file, not a whole location');
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = email ? users.byEmail(email) : null;
    if (!user || user.disabled) throw badRequest(`no account for ${email || 'that email'} — an admin can add one under People`);
    if (user.id === req.identity.id) throw badRequest('that is you');
    if (locations.effective(loc, grantLevel(user, loc.cfg.name)) === 'write') throw badRequest(`${user.name} can already edit everything in ${loc.cfg.name}`);
    // one share per person and path: someone else's is not taken over (and downgraded) by sharing it again; an admin may replace it
    const existing = (db.prepare('SELECT * FROM user_shares WHERE user_id = ? AND path = ?').get(user.id, dp.path) as unknown as Row | undefined) ?? null;
    const replaced = existing && existing.owner_id !== req.identity.id ? existing : null;
    if (replaced && req.identity.role !== 'admin')
      throw new HttpError(409, `someone else already shares this with ${user.name}; only they or an admin can change it`);
    db.prepare(
      'INSERT INTO user_shares (owner_id, user_id, path, level, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET owner_id = excluded.owner_id, level = excluded.level, created_at = excluded.created_at',
    ).run(req.identity.id, user.id, dp.path, level, Date.now());
    const row = db.prepare('SELECT * FROM user_shares WHERE user_id = ? AND path = ?').get(user.id, dp.path) as unknown as Row;
    users.audit({
      userId: req.identity.id,
      email: req.identity.email,
      action: 'share.user',
      path: dp.path,
      detail: replaced
        ? { with: user.email, level, replaced: { owner: users.get(replaced.owner_id)?.email ?? '?', level: replaced.level } }
        : { with: user.email, level },
    });
    reply.code(201);
    return toShare(row);
  });

  /** The owner, an admin, or the recipient (who leaves) may remove it. */
  app.delete<{ Params: { id: string } }>('/api/user-shares/:id', async (req) => {
    const row = get(Number(req.params.id));
    const me = req.identity;
    if (!row || (row.owner_id !== me.id && row.user_id !== me.id && me.role !== 'admin')) throw notFound();
    db.prepare('DELETE FROM user_shares WHERE id = ?').run(row.id);
    users.audit({
      userId: me.id,
      email: me.email,
      action: 'share.user.remove',
      path: row.path,
      detail: { with: users.get(row.user_id)?.email ?? '?', by: row.user_id === me.id ? 'recipient' : 'owner' },
    });
    return { ok: true };
  });

  /** Folders shared with the caller that still work: the owner is around and may still see them. */
  app.get('/api/shared-with-me', async (req): Promise<UserShare[]> => {
    const rows = db.prepare('SELECT * FROM user_shares WHERE user_id = ? ORDER BY created_at DESC').all(req.identity.id) as unknown as Row[];
    const out: UserShare[] = [];
    for (const r of rows) {
      const owner = users.get(r.owner_id);
      if (!owner || owner.disabled) continue;
      let dp;
      try {
        dp = parseDrivePath(r.path);
      } catch {
        continue;
      }
      if (!locations.names.includes(dp.location)) continue;
      const loc = locations.get(dp.location);
      const ownerLevel = locations.effective(loc, grantLevel(owner, loc.cfg.name));
      if (ownerLevel === 'none' || locations.isHidden(loc, dp.segments)) continue;
      const st = await loc.provider.stat(dp.segments).catch(() => null);
      if (!st) continue;
      const share = toShare(r);
      out.push({ ...share, level: ownerLevel === 'read' ? 'read' : r.level, kind: st.kind, size: st.size, mtime: st.mtime, mime: st.kind === 'dir' ? '' : mimeOf(share.name) });
    }
    return out;
  });
}
