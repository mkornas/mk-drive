/**
 * Runtime configuration, all from the environment. Defaults suit the Docker
 * image (`/locations`, `/data`); `npm run dev` points them at `../data`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { LocationMode, PasswordLoginMode } from '../../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Comma-separated list; the literal `none` means an empty list (an unset or empty variable means the fallback). */
function envBool(name: string, fallback = false): boolean {
  const v = env(name, '').toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** `DRIVE_PASSWORD_LOGIN`: empty when unset (Settings → Sign-in decides); `lan`, the old name, reads as `local`. */
function envPasswordLogin(): PasswordLoginMode | '' {
  const v = env('DRIVE_PASSWORD_LOGIN', '').toLowerCase();
  if (v === '') return '';
  if (v === 'lan') return 'local';
  if (v !== 'on' && v !== 'local' && v !== 'off') throw new Error('DRIVE_PASSWORD_LOGIN must be one of on, local, off (or unset)');
  return v;
}

function envList(name: string, fallback: string): string[] {
  const raw = env(name, fallback);
  if (raw.trim().toLowerCase() === 'none') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** One entry of `DRIVE_LOCATIONS`. */
export interface LocationConfig {
  name: string;
  path: string;
  mode?: LocationMode;
  icon?: string;
  /** Top-level names never listed nor served (e.g. `.ssh`). */
  hide?: string[];
}

function parseLocations(raw: string): LocationConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`DRIVE_LOCATIONS is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('DRIVE_LOCATIONS must be a JSON array');
  const seen = new Set<string>();
  return parsed.map((l, i) => {
    const loc = l as Partial<LocationConfig>;
    if (!loc || typeof loc.name !== 'string' || !loc.name.trim()) throw new Error(`DRIVE_LOCATIONS[${i}]: "name" is required`);
    if (typeof loc.path !== 'string' || !loc.path.startsWith('/')) throw new Error(`DRIVE_LOCATIONS[${i}]: "path" must be absolute`);
    if (loc.name.includes('/')) throw new Error(`DRIVE_LOCATIONS[${i}]: "name" may not contain "/"`);
    if (seen.has(loc.name)) throw new Error(`DRIVE_LOCATIONS: duplicate name "${loc.name}"`);
    seen.add(loc.name);
    return {
      name: loc.name.trim(),
      path: loc.path,
      mode: loc.mode === 'ro' ? 'ro' : 'rw',
      icon: typeof loc.icon === 'string' ? loc.icon : undefined,
      hide: Array.isArray(loc.hide) ? loc.hide.filter((h): h is string => typeof h === 'string') : [],
    };
  });
}

export const config = {
  app: 'mk-drive' as const,
  version: readVersion(),
  build: env('BUILD_SHA', 'dev'),
  port: envInt('PORT', 8810),
  host: env('HOST', '0.0.0.0'),

  /** Where the built Angular app lives (served as the SPA). Empty = API only. */
  staticDir: env('DRIVE_STATIC_DIR', resolve(here, '../../client/dist/client/browser')),

  /** Explicit locations (JSON). Empty = every directory under `locationsDir`. */
  locations: parseLocations(env('DRIVE_LOCATIONS', '')),
  locationsDir: env('DRIVE_LOCATIONS_DIR', '/locations'),

  /** App-owned, disposable state (thumbnails, shares, trash index). */
  dataDir: env('DRIVE_DATA_DIR', '/data'),

  /** Names never listed nor served, in any directory. */
  hideAlways: envList('DRIVE_HIDE', '.zfs,.mk-drive,.trash'),

  /** The SQLite file for users, sessions, grants and audit. */
  dbFile: env('DRIVE_DB', ''),
  sessionDays: envInt('DRIVE_SESSION_DAYS', 30),

  /** Headless bootstrap: created as the admin when no user exists yet (else the setup page does it). */
  adminEmail: env('DRIVE_ADMIN_EMAIL', ''),
  adminPassword: env('DRIVE_ADMIN_PASSWORD', ''),
  /** A code the set-up page asks for before it creates the first admin (mk-nas shows it on the box). Empty = no code asked. */
  setupToken: env('DRIVE_SETUP_TOKEN', ''),

  /** Cloudflare Access: team name (or full <team>.cloudflareaccess.com) and the application audience tag. */
  accessTeam: env('DRIVE_ACCESS_TEAM', ''),
  accessAud: env('DRIVE_ACCESS_AUD', ''),
  /** Single sign-on through any OpenID Connect provider (Pocket ID, Authelia, …). All three set = enabled. */
  oidcIssuer: env('DRIVE_OIDC_ISSUER', ''),
  oidcClientId: env('DRIVE_OIDC_CLIENT_ID', ''),
  oidcClientSecret: env('DRIVE_OIDC_CLIENT_SECRET', ''),
  /** What the button says: "Sign in with <name>". */
  oidcName: env('DRIVE_OIDC_NAME', 'Single sign-on'),
  /** Signs the ten-minute login cookie; random per start when unset (a restart mid-login just restarts the login). */
  cookieSecret: env('DRIVE_COOKIE_SECRET', ''),
  /**
   * Where the password form is offered: everywhere, only from the local network (the internet sees SSO alone), or never.
   * Unset or empty = an admin picks it on Settings → Sign-in (`on` until then).
   */
  passwordLogin: envPasswordLogin(),

  /**
   * Proxies whose X-Forwarded-For and CF-Connecting-IP are believed (for login throttling and audit only). A Cloudflare
   * Tunnel is one: list where cloudflared connects from (loopback when it runs on the host, the Docker bridge gateway
   * when the drive is a container reached through a published port), or every visitor through it shares one address.
   */
  trustedProxies: envList('DRIVE_TRUSTED_PROXIES', '127.0.0.0/8,::1/128'),

  /** The ffmpeg binary for video thumbnails; missing = no video thumbnails, nothing else changes. */
  ffmpeg: env('DRIVE_FFMPEG', 'ffmpeg'),
  /** poppler's pdftocairo for PDF first-page thumbnails; missing = no PDF thumbnails. */
  pdftocairo: env('DRIVE_PDFTOCAIRO', 'pdftocairo'),
  /** poppler's pdftotext so "search inside files" reads PDFs too; missing = text files only. */
  pdftotext: env('DRIVE_PDFTOTEXT', 'pdftotext'),
  /** Thumbnail cache: directory (under the data dir) and its size cap in MB. */
  thumbDir: env('DRIVE_THUMB_DIR', ''),
  thumbCacheMb: envInt('DRIVE_THUMB_CACHE_MB', 512),

  /** Demo mode: a throwaway sample location and a demo admin, recreated on every start. */
  demo: envBool('DRIVE_DEMO', false),
  /** Demo mode: a directory copied into the demo location on every start (real photos, videos, PDFs to show). */
  demoSeed: env('DRIVE_DEMO_SEED', ''),

  /** Days a deleted item stays in the trash. */
  trashDays: envInt('DRIVE_TRASH_DAYS', 30),

  /** Listing: how many stat() calls run at once (NFS likes this bounded). */
  statConcurrency: envInt('DRIVE_STAT_CONCURRENCY', 32),

  /** NAS mode: the mk-nas agent's Unix socket mounted into the container. Empty = no Storage section, nothing else changes. */
  nasSocket: env('DRIVE_NAS_SOCKET', ''),

  /** NAS mode: a bearer token (32+ characters) for a monitor to read GET /api/nas/monitor — health and version, nothing else. Empty = no such route. */
  nasMonitorToken: env('DRIVE_NAS_MONITOR_TOKEN', ''),
};

if (!config.dbFile) config.dbFile = resolve(config.dataDir, 'mk-drive.db');
if (!config.thumbDir) config.thumbDir = resolve(config.dataDir, 'thumbs');

export type Config = typeof config;
