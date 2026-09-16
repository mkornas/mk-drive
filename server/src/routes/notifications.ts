/**
 * Notifications: which browsers this account wants to be reached on, and how
 * loud something has to be. Managing them needs a real session, like anything
 * about the account itself — an app password cannot subscribe a device.
 */
import type { FastifyInstance } from 'fastify';
import { badRequest, notFound } from '../errors.ts';
import { settingsFor, writePrefs } from '../notify.ts';
import type { Push } from '../push.ts';
import type { Settings } from '../settings.ts';
import type { NotifySettings, NotifySettingsInput, PushSubscribeInput } from '../../../shared/types.ts';
import { sessionOnly } from './app-passwords.ts';

export function registerNotificationRoutes(app: FastifyInstance, push: Push, settings: Settings): void {
  const endpointOf = (body: unknown): string | undefined => {
    const e = (body as { endpoint?: unknown } | undefined)?.endpoint;
    return typeof e === 'string' ? e : undefined;
  };

  app.get<{ Querystring: { endpoint?: string } }>('/api/notifications', async (req): Promise<NotifySettings> => {
    sessionOnly(req);
    return settingsFor(push, settings, req.identity.id, req.query?.endpoint);
  });

  app.put<{ Body: NotifySettingsInput }>('/api/notifications', async (req): Promise<NotifySettings> => {
    sessionOnly(req);
    try {
      writePrefs(settings, req.identity.id, req.body ?? {});
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    return settingsFor(push, settings, req.identity.id);
  });

  app.post<{ Body: PushSubscribeInput }>('/api/notifications/subscribe', async (req): Promise<NotifySettings> => {
    sessionOnly(req);
    try {
      push.subscribe(req.identity.id, req.body, req.headers['user-agent']);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    return settingsFor(push, settings, req.identity.id, endpointOf(req.body));
  });

  app.post<{ Body: { endpoint?: unknown } }>('/api/notifications/unsubscribe', async (req): Promise<NotifySettings> => {
    sessionOnly(req);
    const endpoint = endpointOf(req.body);
    if (!endpoint) throw badRequest('which subscription?');
    push.unsubscribe(req.identity.id, { endpoint });
    return settingsFor(push, settings, req.identity.id);
  });

  app.delete<{ Params: { id: string } }>('/api/notifications/devices/:id', async (req): Promise<NotifySettings> => {
    sessionOnly(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !push.unsubscribe(req.identity.id, { id })) throw notFound('no such device');
    return settingsFor(push, settings, req.identity.id);
  });

  /** "Does this actually work?" — the same path a real alert takes, to this account's devices only. */
  app.post('/api/notifications/test', async (req): Promise<{ sent: number }> => {
    sessionOnly(req);
    const sent = await push.send([req.identity.id], {
      title: 'mk-drive can reach you',
      body: 'This is what an alert from your NAS will look like.',
      severity: 'info',
      tag: 'test',
      link: '/settings/notifications',
    });
    if (sent === 0) throw badRequest(push.supported ? 'no device is subscribed yet — turn notifications on for this browser first' : 'push is not set up on this drive');
    return { sent };
  });
}
