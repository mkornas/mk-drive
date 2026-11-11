/**
 * A sign of life, sent outward. Alerts are pushed by this drive, so the one thing it can never report is that it is
 * off: the power went, the box hung, the network is down. An admin gives it an address to fetch every few minutes
 * (a dead man's switch elsewhere: healthchecks.io, an Uptime Kuma push monitor, a script on another machine) and that
 * side raises the alarm when the requests stop. Nothing about the box travels with the request: a plain GET.
 */
import type { Heartbeat } from '../../shared/types.ts';
import type { Settings } from './settings.ts';

const URL_KEY = 'heartbeat:url';
const LAST_KEY = 'heartbeat:last';
export const EVERY_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

/** http or https, no credentials in it (they would sit in the database and in logs), and short enough to be an address. */
export function heartbeatUrl(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || v.length > 1024) throw new Error('url: an http or https address');
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error('url: an http or https address');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('url: an http or https address');
  if (u.username || u.password) throw new Error('url: no user name or password in the address');
  return u.toString();
}

export function readHeartbeat(settings: Settings): Heartbeat {
  let last: { at?: number; ok?: boolean; error?: string | null } = {};
  try {
    last = JSON.parse(settings.get(LAST_KEY) ?? '{}');
  } catch {
    /* an unreadable last result is no result */
  }
  return {
    url: settings.get(URL_KEY),
    everyMinutes: EVERY_MS / 60_000,
    lastAt: last.at ? new Date(last.at).toISOString() : null,
    lastOk: typeof last.ok === 'boolean' ? last.ok : null,
    lastError: last.error ?? null,
  };
}

export function writeHeartbeat(settings: Settings, url: unknown): Heartbeat {
  const next = heartbeatUrl(url);
  // a new address has not been tried yet: the old one's result says nothing about it
  if (next !== settings.get(URL_KEY)) settings.set(LAST_KEY, null);
  settings.set(URL_KEY, next);
  return readHeartbeat(settings);
}

/** One request, when an address is set. The result is kept for the settings page; a failure is never thrown. */
export async function beat(settings: Settings, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Heartbeat> {
  const url = settings.get(URL_KEY);
  if (!url) return readHeartbeat(settings);
  let ok = false;
  let error: string | null = null;
  try {
    const res = await fetcher(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'mk-drive-heartbeat' } });
    ok = res.ok;
    if (!ok) error = `answered ${res.status}`;
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    error = (e as Error).name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000} s` : (cause?.code ?? cause?.message ?? (e as Error).message);
  }
  // the address may have changed while the request was out: its result belongs to the old one
  if (settings.get(URL_KEY) === url) settings.set(LAST_KEY, JSON.stringify({ at: now, ok, error }));
  return readHeartbeat(settings);
}

/** Beats on a timer. Returns a stop function. */
export function startHeartbeat(settings: Settings, log?: (message: string) => void, every = EVERY_MS): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const h = await beat(settings);
      if (h.url && h.lastOk === false) log?.(`heartbeat: ${h.lastError}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), every);
  timer.unref();
  return () => clearInterval(timer);
}
