/** Resolves a request's drive path to a mounted location, checking the caller's grant. */
import type { FastifyRequest } from 'fastify';
import type { Locations, Mounted } from './locations.ts';
import { type DrivePath, parseDrivePath } from './paths.ts';
import { forbidden, notFound } from './errors.ts';
import { grantLevel, type Users } from './users.ts';
import type { AccessLevel, User } from '../../shared/types.ts';
import type { DatabaseSync } from './db.ts';

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };
const lower = (a: AccessLevel, b: AccessLevel): AccessLevel => (RANK[a] <= RANK[b] ? a : b);

export interface Resolved {
  loc: Mounted;
  dp: DrivePath;
  /** What the caller may do at this path. */
  access: 'read' | 'write';
}

export class Access {
  private readonly locations: Locations;
  private readonly users: Users;
  private readonly db: DatabaseSync;

  constructor(locations: Locations, users: Users, db: DatabaseSync) {
    this.locations = locations;
    this.users = users;
    this.db = db;
  }

  levelOf(req: FastifyRequest, loc: Mounted): AccessLevel {
    const user = this.users.get(req.identity.id);
    if (!user || user.disabled) throw forbidden('account disabled');
    return this.locations.effective(loc, grantLevel(user, loc.cfg.name));
  }

  /**
   * `user`'s access to one path: the location grant, or — when a folder on the
   * way was shared with them — the share's level, never above what its owner
   * may do there right now (a share dies with the owner's grant or account).
   */
  levelForUser(user: User, loc: Mounted, dp: DrivePath): AccessLevel {
    let level = this.locations.effective(loc, grantLevel(user, loc.cfg.name));
    if (level === 'write') return level;
    const rows = this.db.prepare('SELECT owner_id, path, level FROM user_shares WHERE user_id = ? AND (path = ? OR substr(?, 1, length(path) + 1) = path || ?)').all(user.id, dp.path, dp.path, '/') as { owner_id: number; path: string; level: AccessLevel }[];
    for (const r of rows) {
      const owner = this.users.get(r.owner_id);
      if (!owner || owner.disabled) continue;
      const shared = lower(r.level, this.locations.effective(loc, grantLevel(owner, loc.cfg.name)));
      if (RANK[shared] > RANK[level]) level = shared;
    }
    return level;
  }

  /** Parse, check the grant (`need`), refuse hidden names. A missing grant reads as 404 — the name is not leaked. */
  resolve(req: FastifyRequest, raw: string | undefined, need: 'read' | 'write' = 'read'): Resolved {
    const dp = parseDrivePath(raw);
    const loc = this.locations.get(dp.location);
    const user = this.users.get(req.identity.id);
    if (!user || user.disabled) throw forbidden('account disabled');
    const access = this.levelForUser(user, loc, dp);
    if (access === 'none') throw notFound();
    if (need === 'write' && access !== 'write') throw forbidden(`${loc.cfg.name} is read-only for you`);
    if (this.locations.isHidden(loc, dp.segments)) throw notFound();
    return { loc, dp, access };
  }
}
