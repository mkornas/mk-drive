/** The drive's sign of life (`heartbeat.ts`): where it is sent and how the last one went. Admins only, from a real session. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, forbidden } from '../errors.ts';
import { beat, readHeartbeat, writeHeartbeat } from '../heartbeat.ts';
import type { Settings } from '../settings.ts';
import type { Users } from '../users.ts';
import type { Heartbeat } from '../../../shared/types.ts';
import { sessionOnly } from './app-passwords.ts';

export function registerHeartbeatRoutes(app: FastifyInstance, settings: Settings, users: Users): void {
  const admin = (req: FastifyRequest) => {
    if (req.identity?.role !== 'admin') throw forbidden('admins only');
    sessionOnly(req);
  };

  app.get('/api/heartbeat', async (req): Promise<Heartbeat> => {
    admin(req);
    return readHeartbeat(settings);
  });

  /** Saves the address and tries it at once, so the page can say whether the other side answered. */
  app.put<{ Body: { url?: unknown } }>('/api/heartbeat', async (req): Promise<Heartbeat> => {
    admin(req);
    try {
      writeHeartbeat(settings, req.body?.url);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const h = await beat(settings);
    // the address itself can hold the check's secret id: the audit says only that it changed
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'heartbeat.set', detail: { on: h.url !== null } });
    return h;
  });
}
