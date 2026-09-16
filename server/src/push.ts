/**
 * Web push: how the drive reaches a person who is not looking at it. One
 * subscription per browser per account, in the database next to everything
 * else the drive owns, so a restart or a restore keeps them.
 *
 * The signing keys (VAPID) are made once on first use and kept: new keys would
 * make every existing subscription useless. `DRIVE_VAPID_PUBLIC`/`_PRIVATE`
 * override them for an operator who wants to keep their own.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';
import type { NotifySeverity, PushDevice, PushSubscribeInput } from '../../shared/types.ts';
import type { Settings } from './settings.ts';

const VAPID_KEY = 'push.vapid';

export interface PushConfig {
  /** `mailto:…` or a URL, so a push service can tell someone when something is wrong with our requests. */
  subject: string;
  publicKey: string;
  privateKey: string;
}

interface SubRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  name: string;
  added_at: number;
  last_sent_at: number | null;
}

/** What a browser's push service looks like: an https URL and nothing else, since the server POSTs to whatever it is given. */
export function isPushEndpoint(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** "Firefox on Linux" out of a user agent, for the device list. Unknown shapes keep a trimmed original. */
export function deviceName(ua: unknown): string {
  const s = typeof ua === 'string' ? ua.slice(0, 300) : '';
  if (!s) return 'A browser';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  const os = /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? s.slice(0, 60);
}

export interface Notification {
  title: string;
  body: string;
  severity: NotifySeverity;
  /** Where clicking it should land. */
  link?: string;
  /** Replaces an earlier notification with the same tag instead of stacking (the alert's key). */
  tag?: string;
}

export class Push {
  private readonly db: DatabaseSync;
  private readonly cfg: PushConfig | null;

  constructor(db: DatabaseSync, settings: Settings, env: { subject: string; publicKey: string; privateKey: string }) {
    this.db = db;
    this.cfg = configure(settings, env);
    if (this.cfg) webpush.setVapidDetails(this.cfg.subject, this.cfg.publicKey, this.cfg.privateKey);
  }

  get supported(): boolean {
    return this.cfg !== null;
  }

  get publicKey(): string | null {
    return this.cfg?.publicKey ?? null;
  }

  /** This account's browsers; `current` marks the one asking, by its endpoint. */
  devices(userId: number, endpoint?: string): PushDevice[] {
    const rows = this.db.prepare('SELECT * FROM push_subs WHERE user_id = ? ORDER BY added_at').all(userId) as unknown as SubRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      addedAt: new Date(r.added_at).toISOString(),
      lastSentAt: r.last_sent_at === null ? null : new Date(r.last_sent_at).toISOString(),
      current: endpoint !== undefined && r.endpoint === endpoint,
    }));
  }

  /** Remembers a browser. Subscribing again from the same browser replaces the row rather than adding another. */
  subscribe(userId: number, sub: PushSubscribeInput, ua: unknown, now = Date.now()): void {
    if (!this.cfg) throw new Error('push is not set up on this drive');
    if (!isPushEndpoint(sub?.endpoint)) throw new Error('that is not a push endpoint');
    const { p256dh, auth } = sub.keys ?? {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) throw new Error('that subscription has no keys');
    this.db
      .prepare(
        `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, name, added_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, name = excluded.name, added_at = excluded.added_at`,
      )
      .run(userId, sub.endpoint, p256dh, auth, deviceName(ua), now);
  }

  /** By endpoint (the browser turning itself off) or by id (the person forgetting a device from the list). */
  unsubscribe(userId: number, by: { endpoint?: string; id?: number }): boolean {
    if (by.endpoint) return this.db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, by.endpoint).changes > 0;
    if (by.id !== undefined) return this.db.prepare('DELETE FROM push_subs WHERE user_id = ? AND id = ?').run(userId, by.id).changes > 0;
    return false;
  }

  /** Every device of these accounts. Returns how many were sent; a subscription the push service has forgotten is dropped. */
  async send(userIds: number[], n: Notification, now = Date.now()): Promise<number> {
    if (!this.cfg || userIds.length === 0) return 0;
    const rows = this.db
      .prepare(`SELECT * FROM push_subs WHERE user_id IN (${userIds.map(() => '?').join(',')})`)
      .all(...userIds) as unknown as SubRow[];
    const payload = JSON.stringify({
      notification: {
        title: n.title,
        body: n.body,
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-96x96.png',
        tag: n.tag ?? n.title,
        renotify: true,
        requireInteraction: n.severity === 'critical',
        data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: n.link ?? '/storage' } } },
      },
    });
    let sent = 0;
    await Promise.all(
      rows.map(async (r) => {
        try {
          await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, {
            TTL: 3600,
            urgency: n.severity === 'critical' ? 'high' : 'normal',
          });
          sent++;
          this.db.prepare('UPDATE push_subs SET last_sent_at = ? WHERE id = ?').run(now, r.id);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          // 404/410: the browser threw the subscription away (cleared data, uninstalled). Nothing to keep.
          if (status === 404 || status === 410) this.db.prepare('DELETE FROM push_subs WHERE id = ?').run(r.id);
        }
      }),
    );
    return sent;
  }
}

/** The keys: the operator's if they set both, otherwise ours, made once and kept in the settings table. */
function configure(settings: Settings, env: { subject: string; publicKey: string; privateKey: string }): PushConfig | null {
  const subject = env.subject || 'mailto:admin@localhost';
  if (env.publicKey && env.privateKey) return { subject, publicKey: env.publicKey, privateKey: env.privateKey };
  const stored = settings.get(VAPID_KEY);
  if (stored) {
    try {
      const k = JSON.parse(stored) as { publicKey?: unknown; privateKey?: unknown };
      if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string') return { subject, publicKey: k.publicKey, privateKey: k.privateKey };
    } catch {
      /* unreadable: make a new pair below, which costs every device its subscription — better than no push at all */
    }
  }
  try {
    const keys = webpush.generateVAPIDKeys();
    settings.set(VAPID_KEY, JSON.stringify(keys));
    return { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
  } catch {
    return null;
  }
}

/** A tag that survives a reworded title, so an alert replaces its own earlier notification. */
export const tagFor = (key: string): string => `nas:${key || randomUUID()}`;
