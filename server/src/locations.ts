/**
 * The configured (or discovered) locations and their providers. Discovery:
 * every directory directly under `locationsDir`, mode from writability.
 */
import { access, readdir, constants } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Config, LocationConfig } from './config.ts';
import { LocalProvider } from './storage/local.ts';
import type { StorageProvider } from './storage/provider.ts';
import type { AccessLevel, Identity, Location } from '../../shared/types.ts';
import { notFound } from './errors.ts';

export interface Mounted {
  cfg: Required<Pick<LocationConfig, 'name' | 'path' | 'mode' | 'hide'>> & { icon: string; source: Location['source'] };
  provider: StorageProvider;
}

const DEFAULT_ICON = 'hard-drive';

export class Locations {
  private readonly byName = new Map<string, Mounted>();
  private readonly hideAlways: Set<string>;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.hideAlways = new Set(config.hideAlways);
  }

  async init(): Promise<void> {
    let list = this.config.locations;
    if (list.length === 0) list = await discover(this.config.locationsDir);
    for (const l of list) {
      this.byName.set(l.name, {
        cfg: { name: l.name, path: l.path, mode: l.mode ?? 'rw', hide: l.hide ?? [], icon: l.icon ?? DEFAULT_ICON, source: 'mount' },
        provider: new LocalProvider(l.path, { concurrency: this.config.statConcurrency }),
      });
    }
  }

  /** NAS mode made or destroyed a dataset under the locations dir: pick it up, or let it go, without a restart. Only when locations are discovered, not configured. Returns the new names. */
  async rescan(): Promise<string[]> {
    if (this.config.locations.length > 0) return [];
    const added: string[] = [];
    const found = await discover(this.config.locationsDir);
    for (const [name, m] of this.byName) if (m.cfg.source === 'mount' && !found.some((l) => l.name === name)) this.byName.delete(name);
    for (const l of found) {
      if (this.byName.has(l.name)) continue;
      this.byName.set(l.name, {
        cfg: { name: l.name, path: l.path, mode: l.mode ?? 'rw', hide: l.hide ?? [], icon: DEFAULT_ICON, source: 'mount' },
        provider: new LocalProvider(l.path, { concurrency: this.config.statConcurrency }),
      });
      added.push(l.name);
    }
    return added;
  }

  /**
   * NAS mode: the location a dataset mounted at `mountpoint` is, or null. The agent mounts a location dataset at
   * `<its locations dir>/<last name>`, which the container sees as `<locationsDir>/<last name>`; the host's path is not
   * known here, so the last name is matched against the locations found under our locations dir.
   */
  atMountpoint(mountpoint: string | null): string | null {
    if (!mountpoint) return null;
    const name = basename(mountpoint);
    const m = this.byName.get(name);
    return m && m.cfg.source === 'mount' && m.cfg.path === join(this.config.locationsDir, name) ? name : null;
  }

  /** A connector joins the mounts (same rules from here on). */
  add(m: Mounted): void {
    if (this.byName.has(m.cfg.name)) throw new Error(`location "${m.cfg.name}" already exists`);
    this.byName.set(m.cfg.name, m);
  }

  remove(name: string): void {
    this.byName.delete(name);
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): Mounted {
    const m = this.byName.get(name);
    if (!m) throw notFound(`no location "${name}"`);
    return m;
  }

  /** True when this name must never be listed or served inside `location`. */
  isHidden(location: Mounted, segments: readonly string[]): boolean {
    if (segments.length === 0) return false;
    if (segments.some((s) => this.hideAlways.has(s))) return true;
    return location.cfg.hide.includes(segments[0]);
  }

  /** Effective access of `who` (already holding `grant`) to a location: the mode caps the grant. */
  effective(location: Mounted, grant: AccessLevel): AccessLevel {
    if (grant === 'none') return 'none';
    return location.cfg.mode === 'ro' ? 'read' : grant;
  }

  /** The locations `who` may see, with their effective access. `grantOf` = the user's grant per location. */
  async describe(who: Identity, grantOf: (location: string) => AccessLevel): Promise<Location[]> {
    const out: Location[] = [];
    for (const m of this.byName.values()) {
      const access = this.effective(m, grantOf(m.cfg.name));
      if (access === 'none') continue;
      const loc: Location = {
        name: m.cfg.name,
        mode: m.cfg.mode,
        icon: m.cfg.icon,
        source: m.cfg.source,
        access,
        capabilities: { writable: access === 'write', versions: false },
      };
      // one broken location (a remote that refuses its credentials, a mount that vanished) must not take the list down
      const st = await withTimeout(m.provider.stat([]), 4000).catch((e: Error) => ({ failed: e.message }));
      if (st === 'timeout') loc.error = 'not responding';
      else if (st && 'failed' in st) loc.error = st.failed;
      else if (!st || st.kind !== 'dir') loc.error = 'directory not found';
      else {
        const [space, versions] = await Promise.all([m.provider.space().catch(() => null), m.provider.hasVersions().catch(() => false)]);
        if (space) loc.space = space;
        loc.capabilities.versions = versions;
      }
      out.push(loc);
    }
    return out;
  }
}

async function discover(dir: string): Promise<LocationConfig[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LocationConfig[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const path = join(dir, d.name);
    let mode: 'rw' | 'ro' = 'rw';
    try {
      await access(path, constants.W_OK);
    } catch {
      mode = 'ro';
    }
    out.push({ name: d.name, path, mode, hide: [] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms).unref())]);
}
