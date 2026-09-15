import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Users } from '../users.ts';
import type { Locations } from '../locations.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PASSWORD_MIN } from '../users.ts';
import type { AccessLevel, AuditEntry, Role, User } from '../../../shared/types.ts';
import { smbUserNames, type NasClient } from '../nas.ts';
import { sessionOnly } from './app-passwords.ts';
import { revokeSmbAccess } from './nas.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseGrants(raw: unknown, known: string[]): Record<string, AccessLevel> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object') throw badRequest('grants must be an object');
  const out: Record<string, AccessLevel> = {};
  for (const [location, level] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.includes(location)) throw badRequest(`unknown location "${location}"`);
    if (level === 'read' || level === 'write') out[location] = level;
    else if (level !== 'none' && level !== null) throw badRequest(`bad level for "${location}"`);
  }
  return out;
}

/** User management and the audit log — admins only. */
export function registerAdminRoutes(app: FastifyInstance, users: Users, locations: Locations, nas: NasClient | null = null): void {
  const admin = (req: FastifyRequest) => {
    if (req.identity?.role !== 'admin') throw forbidden('admins only');
    sessionOnly(req);
  };

  app.get('/api/users', async (req): Promise<User[]> => {
    admin(req);
    return users.list();
  });

  app.post<{ Body: { email?: unknown; name?: unknown; role?: unknown; password?: unknown; grants?: unknown } }>(
    '/api/users',
    async (req, reply): Promise<User> => {
      admin(req);
      const b = req.body ?? {};
      if (typeof b.email !== 'string' || !EMAIL.test(b.email.trim())) throw badRequest('a valid email is required');
      if (typeof b.name !== 'string' || !b.name.trim()) throw badRequest('a name is required');
      if (typeof b.password !== 'string' || b.password.length < PASSWORD_MIN) throw badRequest(`password must be at least ${PASSWORD_MIN} characters`);
      const role: Role = b.role === 'admin' ? 'admin' : 'member';
      if (users.byEmail(b.email)) throw badRequest('that email already has an account');
      const user = await users.create({ email: b.email, name: b.name, role, password: b.password, grants: parseGrants(b.grants, locations.names) });
      users.audit({ userId: req.identity.id, email: req.identity.email, action: 'user.create', detail: { id: user.id, email: user.email, role } });
      reply.code(201);
      return user;
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown; role?: unknown; disabled?: unknown; grants?: unknown; password?: unknown } }>(
    '/api/users/:id',
    async (req): Promise<User> => {
      admin(req);
      const id = Number(req.params.id);
      const existing = users.get(id);
      if (!existing) throw notFound('no such user');
      const b = req.body ?? {};
      const patch: { name?: string; role?: Role; disabled?: boolean } = {};
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim()) throw badRequest('a name is required');
        patch.name = b.name;
      }
      if (b.role !== undefined) {
        if (b.role !== 'admin' && b.role !== 'member') throw badRequest('role must be admin or member');
        patch.role = b.role;
      }
      if (b.disabled !== undefined) patch.disabled = !!b.disabled;
      const demoting = (patch.role === 'member' && existing.role === 'admin') || (patch.disabled && existing.role === 'admin' && !existing.disabled);
      if (demoting && users.admins() <= 1) throw badRequest('that would leave no admin');
      if (id === req.identity.id && (patch.disabled || patch.role === 'member')) throw badRequest('you cannot lock yourself out');
      // the SMB name as it is now, before anything about the account changes
      const smbName = smbUserNames(users.accounts()).get(id);
      users.update(id, patch);
      if (nas && smbName && patch.disabled && !existing.disabled)
        await revokeSmbAccess(nas, users, smbName, 'disabled', { userId: req.identity.id, email: req.identity.email });
      if (b.grants !== undefined) users.setGrants(id, parseGrants(b.grants, locations.names));
      let appPasswordsRevoked: number | undefined;
      if (b.password !== undefined) {
        if (typeof b.password !== 'string' || b.password.length < PASSWORD_MIN) throw badRequest(`password must be at least ${PASSWORD_MIN} characters`);
        await users.setPassword(id, b.password);
        users.deleteOtherSessions(id, undefined);
        // a reset is for an account someone else may hold: its apps (WebDAV, the iOS app) sign in again too
        appPasswordsRevoked = users.deleteAppPasswordsOf(id);
      }
      users.audit({
        userId: req.identity.id,
        email: req.identity.email,
        action: 'user.update',
        detail: { id, ...patch, grants: b.grants !== undefined, password: b.password !== undefined, appPasswordsRevoked },
      });
      return users.get(id)!;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    admin(req);
    const id = Number(req.params.id);
    const existing = users.get(id);
    if (!existing) throw notFound('no such user');
    if (id === req.identity.id) throw badRequest('you cannot delete yourself');
    if (existing.role === 'admin' && !existing.disabled && users.admins() <= 1) throw badRequest('that would leave no admin');
    const smbName = smbUserNames(users.accounts()).get(id);
    users.remove(id);
    if (nas && smbName) await revokeSmbAccess(nas, users, smbName, 'deleted', { userId: req.identity.id, email: req.identity.email });
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'user.delete', detail: { id, email: existing.email } });
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string; before?: string } }>('/api/audit', async (req): Promise<AuditEntry[]> => {
    admin(req);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const before = Number(req.query.before) || undefined;
    return users.auditList(limit, before);
  });
}
