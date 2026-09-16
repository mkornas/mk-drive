/**
 * Telling people what the NAS says. The agent decides what is wrong
 * (`mk-nas/docs/alerts.md`); this watches that list and pushes the changes to
 * the admins who asked to hear about them.
 *
 * Rules, so the drive is never a nuisance: only alerts the agent has confirmed
 * (a blip is not worth a phone buzzing), only what the person asked for
 * (`minSeverity`), never the same alert twice, and one quiet "it's over" when
 * something that was pushed clears. The tag is the alert's key, so a
 * notification replaces its own earlier one instead of stacking.
 */
import type { Alert, Alerts } from '../../shared/nas.ts';
import type { NotifySettings, NotifySettingsInput, NotifySeverity } from '../../shared/types.ts';
import type { Push } from './push.ts';
import type { Settings } from './settings.ts';
import type { Users } from './users.ts';

const RANK: Record<NotifySeverity, number> = { critical: 2, warning: 1, info: 0 };
const PREFS = (userId: number) => `notify:${userId}`;

interface Prefs {
  minSeverity: NotifySeverity;
  nasAlerts: boolean;
}

const DEFAULTS: Prefs = { minSeverity: 'warning', nasAlerts: true };

export function readPrefs(settings: Settings, userId: number): Prefs {
  const raw = settings.get(PREFS(userId));
  if (!raw) return { ...DEFAULTS };
  try {
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      minSeverity: p.minSeverity && p.minSeverity in RANK ? p.minSeverity : DEFAULTS.minSeverity,
      nasAlerts: typeof p.nasAlerts === 'boolean' ? p.nasAlerts : DEFAULTS.nasAlerts,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrefs(settings: Settings, userId: number, input: NotifySettingsInput): Prefs {
  const now = readPrefs(settings, userId);
  if (input.minSeverity !== undefined) {
    if (!(input.minSeverity in RANK)) throw new Error('minSeverity: critical, warning or info');
    now.minSeverity = input.minSeverity;
  }
  if (input.nasAlerts !== undefined) {
    if (typeof input.nasAlerts !== 'boolean') throw new Error('nasAlerts must be true or false');
    now.nasAlerts = input.nasAlerts;
  }
  settings.set(PREFS(userId), JSON.stringify(now));
  return now;
}

export function settingsFor(push: Push, settings: Settings, userId: number, endpoint?: string): NotifySettings {
  const p = readPrefs(settings, userId);
  return { supported: push.supported, publicKey: push.publicKey, devices: push.devices(userId, endpoint), minSeverity: p.minSeverity, nasAlerts: p.nasAlerts };
}

/** What a change in the alert list means for the people watching it. Pure, so the rules can be tested without a NAS. */
export interface Decision {
  /** Newly confirmed alerts worth pushing, worst first. */
  raised: Alert[];
  /** Alerts we pushed before that are over now. */
  cleared: Alert[];
}

export function decide(previousNotified: Set<string>, alerts: Alerts, minSeverity: NotifySeverity): Decision {
  const worthIt = (a: Alert) => a.confirmed && RANK[a.severity] >= RANK[minSeverity];
  const raised = alerts.open.filter((a) => worthIt(a) && !previousNotified.has(a.key)).sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const open = new Set(alerts.open.map((a) => a.key));
  const cleared = alerts.recent.filter((a) => previousNotified.has(a.key) && !open.has(a.key));
  return { raised, cleared };
}

const NOTIFIED = 'notify:nas:notified';

export interface WatchDeps {
  push: Push;
  settings: Settings;
  users: Users;
  /** Reads the agent's alerts; null when this drive has no NAS. */
  alerts: () => Promise<Alerts>;
  log?: (message: string) => void;
}

/**
 * One pass: read the agent's alerts, push what each admin has not heard yet,
 * and remember what was sent so nobody is told twice. Alerts are admin-only
 * (they are about the machine), so members are never notified.
 */
export async function watchOnce(deps: WatchDeps, now = Date.now()): Promise<{ sent: number }> {
  const admins = deps.users.list().filter((u) => u.role === 'admin' && !u.disabled);
  if (admins.length === 0) return { sent: 0 };
  let alerts: Alerts;
  try {
    alerts = await deps.alerts();
  } catch (e) {
    // an agent that is older than the alerts verb, or a socket that went away: nothing to say, try again next time
    deps.log?.(`alerts: ${(e as Error).message}`);
    return { sent: 0 };
  }
  const notified = new Set(JSON.parse(deps.settings.get(NOTIFIED) ?? '[]') as string[]);
  let sent = 0;
  const stillNotified = new Set<string>();
  for (const admin of admins) {
    const prefs = readPrefs(deps.settings, admin.id);
    if (!prefs.nasAlerts) continue;
    const { raised, cleared } = decide(notified, alerts, prefs.minSeverity);
    for (const a of raised) {
      sent += await deps.push.send([admin.id], { title: a.title, body: a.detail ?? 'Open Storage to see what to do.', severity: a.severity, tag: `nas:${a.key}`, link: '/storage' }, now);
      stillNotified.add(a.key);
    }
    for (const a of cleared) {
      sent += await deps.push.send([admin.id], { title: `Over: ${a.title}`, body: 'The box says this is fine again.', severity: 'info', tag: `nas:${a.key}`, link: '/storage' }, now);
    }
  }
  // what is still open and was told to somebody stays remembered; anything cleared is forgotten, so it can be told again if it returns
  const open = new Set(alerts.open.map((a) => a.key));
  const keep = [...new Set([...[...notified].filter((k) => open.has(k)), ...stillNotified])];
  deps.settings.set(NOTIFIED, JSON.stringify(keep));
  return { sent };
}

/** Runs `watchOnce` on a timer. Returns a stop function; nothing runs when the drive has no NAS. */
export function watchAlerts(deps: WatchDeps, every = 60_000): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await watchOnce(deps);
    } catch (e) {
      deps.log?.(`notify: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), every);
  timer.unref();
  return () => clearInterval(timer);
}
