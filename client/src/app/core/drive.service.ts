import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Identity, Location, Meta, UserShare } from '../../../../shared/types';
import { ApiService } from './api.service';

/** App-wide state: who we are, which locations we may see. */
@Injectable({ providedIn: 'root' })
export class DriveService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly meta = signal<Meta | null>(null);
  readonly locations = signal<Location[]>([]);
  /** Folders other people shared with the signed-in user (they may lie outside every visible location). */
  readonly shared = signal<UserShare[]>([]);
  readonly me = computed<Identity | null>(() => this.meta()?.me ?? null);
  readonly signedIn = computed(() => this.me() !== null);
  readonly isAdmin = computed(() => this.me()?.role === 'admin');
  /** NAS mode: the server has the mk-nas socket and we are an admin, so the Storage section is there. */
  readonly nas = computed(() => this.isAdmin() && !!this.meta()?.nas);
  /** What the header calls this drive: the admin's name for it, or the app's. */
  readonly name = computed(() => this.meta()?.name || this.meta()?.app || 'mk-drive');
  /** Starred paths of the signed-in user, kept locally so the UI can mark rows without a round trip. */
  readonly stars = signal<Set<string>>(new Set());
  private loading: Promise<void> | null = null;

  /** Load meta, then locations when signed in. Safe to call repeatedly. */
  ready(): Promise<void> {
    if (!this.loading) this.loading = this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(): Promise<void> {
    const meta = await this.api.meta();
    this.meta.set(meta);
    if (meta.me) {
      await this.refreshLocations();
      void this.loadStars();
    } else {
      this.locations.set([]);
      this.shared.set([]);
    }
  }

  async loadStars(): Promise<void> {
    try {
      this.stars.set(new Set((await this.api.stars()).map((e) => e.path)));
    } catch {
      /* not fatal */
    }
  }

  isStarred(path: string): boolean {
    return this.stars().has(path);
  }

  async toggleStar(path: string): Promise<boolean> {
    const on = !this.isStarred(path);
    if (on) await this.api.star(path);
    else await this.api.unstar(path);
    this.stars.update((s) => {
      const next = new Set(s);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
    return on;
  }

  location(name: string): Location | undefined {
    return this.locations().find((l) => l.name === name);
  }

  async refreshLocations(): Promise<void> {
    const [locations, shared] = await Promise.all([this.api.locations(), this.api.sharedWithMe().catch(() => [] as UserShare[])]);
    this.locations.set(locations);
    this.shared.set(shared);
  }

  /** The shared folder that `path` lives in, when its location is not otherwise visible to the user. */
  sharedRootOf(path: string): UserShare | undefined {
    if (this.location(path.split('/')[0])) return undefined;
    return this.shared()
      .filter((s) => path === s.path || path.startsWith(s.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

  async signedInAs(id: Identity): Promise<void> {
    const meta = this.meta();
    this.meta.set(meta ? { ...meta, me: id, setupRequired: false, reason: undefined } : meta);
    await this.refreshLocations();
    void this.loadStars();
  }

  /** An admin renamed the drive: the header follows at once. */
  setDriveName(name: string | null): void {
    const meta = this.meta();
    if (meta) this.meta.set({ ...meta, name: name ?? undefined });
  }

  setName(name: string): void {
    const meta = this.meta();
    if (meta?.me) this.meta.set({ ...meta, me: { ...meta.me, name } });
  }

  async signOut(): Promise<void> {
    const out = await this.api.logout().catch(() => null);
    if (out?.redirect) {
      // the provider ends its own session and sends the browser back to /login
      location.assign(out.redirect);
      return;
    }
    const meta = this.meta();
    if (meta) this.meta.set({ ...meta, me: null });
    this.locations.set([]);
    this.shared.set([]);
    await this.router.navigate(['/login']);
  }
}
