/** The UniFi console the drive reads client names from (`unifi.ts`). Admins only, from a real session. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, forbidden } from '../errors.ts';
import type { Unifi } from '../unifi.ts';
import type { Users } from '../users.ts';
import type { Unifi as UnifiState, UnifiInput } from '../../../shared/types.ts';
import { sessionOnly } from './app-passwords.ts';

export function registerUnifiRoutes(app: FastifyInstance, unifi: Unifi, users: Users): void {
  const admin = (req: FastifyRequest) => {
    if (req.identity?.role !== 'admin') throw forbidden('admins only');
    sessionOnly(req);
  };

  app.get('/api/unifi', async (req): Promise<UnifiState> => {
    admin(req);
    return unifi.read();
  });

  /** Saved only once the console answered with this address and key. */
  app.put<{ Body: Partial<UnifiInput> }>('/api/unifi', async (req): Promise<UnifiState> => {
    admin(req);
    let state: UnifiState;
    try {
      state = await unifi.save(req.body ?? {});
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'unifi.set', detail: { url: state.url, fingerprint: state.fingerprint } });
    return state;
  });

  app.delete('/api/unifi', async (req): Promise<UnifiState> => {
    admin(req);
    const state = unifi.remove();
    users.audit({ userId: req.identity.id, email: req.identity.email, action: 'unifi.remove', detail: {} });
    return state;
  });
}
