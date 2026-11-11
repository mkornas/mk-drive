/**
 * Names for addresses, from a UniFi console. The NAS knows who is connected only by address; the network's own
 * controller knows what each address is called. An admin gives this drive the console's address and an API key
 * (UniFi Network → Settings → Control Plane → Integrations) and the drive reads the client list from the console's
 * local Integration API. It only ever reads: `/info`, `/sites`, `/sites/<id>/clients`.
 *
 * A console answers with a certificate it signed itself, so there is nothing to verify it against. Like ssh, the
 * certificate seen when the address is saved is the one trusted from then on (its fingerprint is shown to the
 * admin), and the key is never sent to anything else: a changed certificate is an error until the address is saved
 * again. A console with a real certificate is verified the usual way and nothing is pinned.
 */
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { isIP } from 'node:net';
import type { Unifi as UnifiState } from '../../shared/types.ts';
import type { Settings } from './settings.ts';

const URL_KEY = 'unifi:url';
const KEY_KEY = 'unifi:key';
const CERT_KEY = 'unifi:cert';
const LAST_KEY = 'unifi:last';
const API = '/proxy/network/integration/v1';
const TIMEOUT_MS = 10_000;
const MAX_BODY = 4 * 1024 * 1024;
const PAGE = 200;
const MAX_PAGES = 25;
const FRESH_MS = 60_000;

/** https, a host and maybe a port: the console's own address, nothing after it. */
export function consoleUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 255) throw new Error('url: the console\'s https address');
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`);
  } catch {
    throw new Error('url: the console\'s https address');
  }
  if (u.protocol !== 'https:') throw new Error('url: https only — the key travels in every request');
  if (u.username || u.password) throw new Error('url: no user name or password in the address');
  return u.origin;
}

export function apiKey(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,512}$/.test(v.trim())) throw new Error('key: that does not look like an API key');
  return v.trim();
}

interface Conn {
  url: string;
  key: string;
  /** The pinned certificate as PEM; null when the console's certificate verifies by itself. */
  cert: string | null;
}

const fingerprintOf = (pem: string): string => new X509Certificate(pem).fingerprint256;

/** The certificate a host presents, and whether it verifies without help. Nothing is sent but the handshake. */
export function peerCertificate(origin: string): Promise<{ pem: string; trusted: boolean }> {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const sock = connect({ host: u.hostname, port: Number(u.port || 443), servername: isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const cert = sock.getPeerX509Certificate();
      const trusted = sock.authorized;
      sock.destroy();
      if (!cert) reject(new Error('the console showed no certificate'));
      else resolve({ pem: cert.toString(), trusted });
    });
    sock.on('timeout', () => sock.destroy(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)));
    sock.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code ?? e.message)));
  });
}

function getJson<T>(c: Conn, path: string): Promise<T> {
  const u = new URL(c.url);
  const pinned = c.cert ? fingerprintOf(c.cert) : null;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: Number(u.port || 443),
        path: API + path,
        method: 'GET',
        headers: { 'x-api-key': c.key, accept: 'application/json' },
        timeout: TIMEOUT_MS,
        // a connection is never reused across a certificate check
        agent: false,
        ...(c.cert
          ? {
              ca: c.cert,
              // the name on a console's own certificate is not its address; the pinned certificate is the identity
              checkServerIdentity: (_host: string, cert: { fingerprint256: string }) =>
                cert.fingerprint256 === pinned ? undefined : new Error('the console\'s certificate is not the one that was saved'),
            }
          : {}),
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > MAX_BODY) req.destroy(new Error('the answer is too large'));
          else chunks.push(d);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) return reject(new Error('the console refused the API key'));
          if (status < 200 || status >= 300) return reject(new Error(`the console answered ${status}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            reject(new Error('the console did not answer in JSON — is this a UniFi console with Network 9 or newer?'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)));
    req.on('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(/certificate|self.signed|CERT_|UNABLE_TO_VERIFY/i.test(`${e.code} ${e.message}`) ? 'the console\'s certificate is not the one that was saved; save the address again if the console was replaced or reset' : (e.code ?? e.message))),
    );
    req.end();
  });
}

interface Page<T> {
  offset: number;
  limit: number;
  count: number;
  totalCount: number;
  data: T[];
}

async function all<T>(c: Conn, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await getJson<Page<T>>(c, `${path}?offset=${out.length}&limit=${PAGE}`);
    if (!Array.isArray(p?.data)) throw new Error('the console answered something that is not a list');
    out.push(...p.data);
    if (p.data.length === 0 || out.length >= (p.totalCount ?? 0)) break;
  }
  return out;
}

interface Site {
  id: string;
  name?: string;
}
interface Client {
  name?: string;
  ipAddress?: string;
}

/** Every client's name by address, over all sites; a client the console has no name for is left out. */
async function fetchNames(c: Conn): Promise<{ names: Map<string, string>; sites: string[] }> {
  const sites = await all<Site>(c, '/sites');
  const names = new Map<string, string>();
  for (const s of sites) {
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(s.id)) continue;
    for (const cl of await all<Client>(c, `/sites/${s.id}/clients`)) {
      if (typeof cl.ipAddress === 'string' && typeof cl.name === 'string' && cl.name.trim()) names.set(cl.ipAddress, cl.name.trim().slice(0, 120));
    }
  }
  return { names, sites: sites.map((s) => s.name ?? s.id).filter((n): n is string => typeof n === 'string') };
}

export class Unifi {
  private readonly settings: Settings;
  private cache: { at: number; names: Map<string, string> } | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  private conn(): Conn | null {
    const url = this.settings.get(URL_KEY);
    const key = this.settings.get(KEY_KEY);
    return url && key ? { url, key, cert: this.settings.get(CERT_KEY) } : null;
  }

  private note(ok: boolean, error: string | null, clients: number | null, sites: string[], now: number): void {
    this.settings.set(LAST_KEY, JSON.stringify({ at: now, ok, error, clients, sites }));
  }

  /** What the settings page shows. The key itself never leaves the server. */
  read(): UnifiState {
    const cert = this.settings.get(CERT_KEY);
    let last: { at?: number; ok?: boolean; error?: string | null; clients?: number | null; sites?: string[] } = {};
    try {
      last = JSON.parse(this.settings.get(LAST_KEY) ?? '{}');
    } catch {
      /* an unreadable last result is no result */
    }
    return {
      url: this.settings.get(URL_KEY),
      hasKey: !!this.settings.get(KEY_KEY),
      fingerprint: cert ? fingerprintOf(cert) : null,
      sites: last.sites ?? [],
      clients: last.clients ?? null,
      lastAt: last.at ? new Date(last.at).toISOString() : null,
      lastOk: typeof last.ok === 'boolean' ? last.ok : null,
      lastError: last.error ?? null,
    };
  }

  /**
   * Saves the address (and a key; without one the saved key is kept, for the same address only) after the console
   * answered with it. The certificate it shows now is the one pinned, so this is also how a replaced console is accepted.
   */
  async save(input: { url?: unknown; key?: unknown }, now = Date.now()): Promise<UnifiState> {
    const url = consoleUrl(input.url);
    const kept = url === this.settings.get(URL_KEY) ? this.settings.get(KEY_KEY) : null;
    const key = input.key === undefined || input.key === '' ? kept : apiKey(input.key);
    if (!key) throw new Error('key: an API key from the console is needed');
    const peer = await peerCertificate(url);
    const c: Conn = { url, key, cert: peer.trusted ? null : peer.pem };
    const { names, sites } = await fetchNames(c);
    this.settings.set(URL_KEY, url);
    this.settings.set(KEY_KEY, key);
    this.settings.set(CERT_KEY, c.cert);
    this.cache = { at: now, names };
    this.note(true, null, names.size, sites, now);
    return this.read();
  }

  remove(): UnifiState {
    for (const k of [URL_KEY, KEY_KEY, CERT_KEY, LAST_KEY]) this.settings.set(k, null);
    this.cache = null;
    return this.read();
  }

  /** Names by address, read at most once a minute. Never throws: a console that is away means addresses stay addresses. */
  async names(now = Date.now()): Promise<Map<string, string>> {
    const c = this.conn();
    if (!c) return new Map();
    if (this.cache && now - this.cache.at < FRESH_MS) return this.cache.names;
    try {
      const { names, sites } = await fetchNames(c);
      this.cache = { at: now, names };
      this.note(true, null, names.size, sites, now);
    } catch (e) {
      // the last list stays in use for this minute rather than asking a console that is down on every page load
      this.cache = { at: now, names: this.cache?.names ?? new Map() };
      this.note(false, (e as Error).message, null, [], now);
    }
    return this.cache.names;
  }
}
