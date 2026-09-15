/**
 * App passwords: long random secrets for clients that cannot do a browser
 * sign-in (curl, scripts, WebDAV). Sent as `Authorization: Basic email:secret`
 * or `Bearer secret`; `auth.ts` maps one to its user. A secret is shown once.
 * Managing them — like everything about the account itself — needs a real
 * session: a leaked app password cannot mint more of them.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashToken } from '../auth.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import type { AppPasswordRow, Users } from '../users.ts';
import type { AppPassword, AppPasswordCreated } from '../../../shared/types.ts';

/** Account-level routes refuse an app password: only a session (or an Access identity) may use them. Nobody signed in passes (the route decides). */
export function sessionOnly(req: FastifyRequest): void {
  if (req.identity?.via === 'token') throw forbidden('sign in with a browser to manage the account');
}

export function registerAppPasswordRoutes(app: FastifyInstance, users: Users): void {
  const toPublic = (r: AppPasswordRow): AppPassword => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    lastIp: r.last_ip,
  });

  app.get('/api/app-passwords', async (req): Promise<AppPassword[]> => {
    sessionOnly(req);
    return users.appPasswords(req.identity.id).map(toPublic);
  });

  app.post<{ Body: { name?: unknown } }>('/api/app-passwords', async (req, reply): Promise<AppPasswordCreated> => {
    sessionOnly(req);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
    if (!name) throw badRequest('give it a name — the device or program that will use it');
    if (users.appPasswords(req.identity.id).length >= 20) throw badRequest('twenty app passwords is plenty; remove one first');
    const secret = randomBytes(30).toString('base64url');
    const row = users.createAppPassword(req.identity.id, name, hashToken(secret), secret.slice(0, 6));
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'token.create', detail: name });
    reply.code(201);
    return { ...toPublic(row), secret };
  });

  app.delete<{ Params: { id: string } }>('/api/app-passwords/:id', async (req) => {
    sessionOnly(req);
    const id = Number(req.params.id);
    const row = users.appPasswords(req.identity.id).find((r) => r.id === id);
    if (!row || !users.deleteAppPassword(req.identity.id, id)) throw notFound();
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'token.revoke', detail: row.name });
    return { ok: true };
  });
}
