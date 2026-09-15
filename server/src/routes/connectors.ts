/** Admin-only: the connectors (WebDAV / S3 locations) an operator adds in the app. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Connectors } from '../connectors.ts';
import type { Users } from '../users.ts';
import { forbidden, notFound } from '../errors.ts';
import { sessionOnly } from './app-passwords.ts';
import type { Connector, ConnectorInput } from '../../../shared/types.ts';

export function registerConnectorRoutes(app: FastifyInstance, connectors: Connectors, users: Users): void {
  const admin = (req: FastifyRequest) => {
    if (req.identity?.role !== 'admin') throw forbidden('admins only');
    sessionOnly(req);
  };

  app.get('/api/connectors', async (req): Promise<Connector[]> => {
    admin(req);
    return connectors.list();
  });

  app.post<{ Body: ConnectorInput }>('/api/connectors', async (req, reply): Promise<Connector> => {
    admin(req);
    const c = await connectors.add(req.body ?? ({} as ConnectorInput));
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'connector.add', detail: { name: c.name, type: c.type } });
    reply.code(201);
    return c;
  });

  app.delete<{ Params: { name: string } }>('/api/connectors/:name', async (req) => {
    admin(req);
    if (!connectors.remove(req.params.name)) throw notFound();
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'connector.remove', detail: { name: req.params.name } });
    return { ok: true };
  });
}
