import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkInput, MkSwitch } from '@mk-kit/ui/forms';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import type { Arrival, Entry, MarkedEntry, SearchResult } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { ago, bytes } from '../core/format';
import { iconFor } from '../core/file-kind';

const WEEK = 7 * 86_400_000;

/**
 * `/`: where you land. What arrived lately (your uploads and what visitors sent
 * through file-request links), the locations and how full they are, and the
 * things you were looking at. Explains itself when there is nothing yet.
 */
@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkIcon, MkInput, MkSwitch, MkEmptyState, MkSpinner],
  template: `
    @if (state() === 'loading') {
      <div class="center"><mk-spinner /></div>
    } @else if (state() === 'empty') {
      <div class="center">
        <mk-empty-state icon="hard-drive" title="No locations" [description]="drive.isAdmin() ? 'Mount directories under /locations or set DRIVE_LOCATIONS, then restart the server.' : 'Nothing has been shared with you yet. Ask the admin of this drive for access.'" />
      </div>
    } @else {
      <div class="page">
        <div class="find">
          <mk-icon name="search" size="sm" class="find__icon" />
          <input mkInput type="search" class="find__input" [value]="query()" (input)="query.set($any($event.target).value)" placeholder="Search the whole drive…" aria-label="Search the whole drive" />
          <label class="find__mode muted"><mk-switch [(checked)]="inFiles" size="sm" aria-label="Search inside files" /> inside files</label>
        </div>

        @if (query().trim()) {
          <section class="arrivals" aria-live="polite">
            @if (results(); as r) {
              <h1>{{ r.entries.length }} result{{ r.entries.length === 1 ? '' : 's' }} for “{{ query().trim() }}”</h1>
              <p class="lead muted">{{ inFiles() ? 'Inside text files and PDFs' : 'By name' }}, across every location you can open{{ r.truncated ? ' — stopped early; a longer word or a search inside one folder narrows it' : '' }}{{ inFiles() && r.scanned !== undefined ? ' · ' + r.scanned + ' file' + (r.scanned === 1 ? '' : 's') + ' read' : '' }}.</p>
              @if (r.entries.length === 0) {
                <mk-empty-state icon="search-off" title="Nothing matches" [description]="inFiles() ? 'Try another word, or search by name instead.' : 'Try a shorter word, or switch on “inside files” to look through the contents.'" />
              } @else {
                <ol class="feed">
                  @for (e of r.entries; track e.path) {
                    <li>
                      <button type="button" class="row" (click)="open(e)">
                        <span class="row__media">
                          @if (e.thumb) {
                            <img [src]="api.thumbUrl(e.path, 160)" alt="" loading="lazy" (error)="$any($event.target).hidden = true" />
                          }
                          <mk-icon [name]="icon(e)" size="sm" class="row__icon" [class.row__icon--dir]="e.kind === 'dir'" />
                        </span>
                        <span class="row__text">
                          <span class="row__name">{{ e.name }}</span>
                          <span class="row__where muted">{{ parent(e.path) }}</span>
                          @if (e.snippet) {<span class="row__snippet">{{ e.snippet }}</span>}
                        </span>
                        <span class="row__size muted">{{ e.kind === 'dir' ? 'folder' : f.bytes(e.size) }}</span>
                        <span class="row__when muted">{{ f.ago(e.mtime) }}</span>
                      </button>
                    </li>
                  }
                </ol>
              }
            } @else if (searchError(); as err) {
              <mk-empty-state icon="circle-alert" title="Could not search" [description]="err" />
            } @else {
              <h1>Searching…</h1>
              <div class="center"><mk-spinner /></div>
            }
          </section>
        } @else {
        <nav class="places" aria-label="Locations">
          @for (loc of drive.locations(); track loc.name) {
            <a class="place" [href]="'/d/' + encode(loc.name)" (click)="go($event, '/d/' + encode(loc.name))">
              <mk-icon [name]="loc.error ? 'circle-alert' : loc.icon" size="sm" class="place__icon" />
              <span class="place__name">{{ loc.name }}</span>
              @if (loc.space; as sp) {
                <span class="place__bar" aria-hidden="true"><span [style.width.%]="used(sp)"></span></span>
                <span class="place__meta muted">{{ f.bytes(sp.total - sp.free, 0) }} of {{ f.bytes(sp.total, 0) }}</span>
              } @else {
                <span class="place__meta muted">{{ loc.error ? 'not mounted' : loc.access === 'read' ? 'view only' : loc.source === 'mount' ? 'mounted' : loc.source }}</span>
              }
            </a>
          }
        </nav>

        <section class="arrivals">
          <h1>New on the drive</h1>
          <p class="lead muted">{{ summary() }}</p>
          @if (arrivals(); as list) {
            @if (list.length === 0) {
              <mk-empty-state icon="upload" title="Nothing has arrived yet" description="Files you upload, and files people send through a file-request link, show up here." />
            } @else {
              <ol class="feed">
                @for (a of list; track a.path) {
                  <li>
                    <button type="button" class="row" (click)="open(a)">
                      <span class="row__media">
                        @if (a.thumb) {
                          <img [src]="api.thumbUrl(a.path, 160)" alt="" loading="lazy" (error)="$any($event.target).hidden = true" />
                        }
                        <mk-icon [name]="icon(a)" size="sm" class="row__icon" />
                      </span>
                      <span class="row__text">
                        <span class="row__name">{{ a.name }}</span>
                        <span class="row__where muted">{{ parent(a.path) }}</span>
                      </span>
                      <span class="row__by muted">{{ a.viaLink ? 'sent through a link' : a.by.email === drive.me()?.email ? 'you' : a.by.name }}</span>
                      <span class="row__size muted">{{ f.bytes(a.size) }}</span>
                      <span class="row__when muted">{{ f.ago(a.at) }}</span>
                    </button>
                  </li>
                }
              </ol>
            }
          } @else {
            <mk-spinner />
          }
        </section>

        <div class="columns">
          <section>
            <h2>Recent</h2>
            @if (recent(); as list) {
              @if (list.length === 0) {
                <p class="muted note">Files you preview show up here.</p>
              } @else {
                <ul class="list">
                  @for (e of list; track e.path) {
                    <li><button type="button" class="item" (click)="open(e)"><mk-icon [name]="icon(e)" size="sm" [class.dir]="e.kind === 'dir'" /><span class="item__name">{{ e.name }}</span><span class="item__meta muted">{{ f.ago(e.at) }}</span></button></li>
                  }
                </ul>
                <a class="more" href="/recent" (click)="go($event, '/recent')">All recent</a>
              }
            }
          </section>
          <section>
            <h2>Starred</h2>
            @if (starred(); as list) {
              @if (list.length === 0) {
                <p class="muted note">Right-click a file or folder and choose Star to keep it at hand.</p>
              } @else {
                <ul class="list">
                  @for (e of list; track e.path) {
                    <li><button type="button" class="item" (click)="open(e)"><mk-icon [name]="icon(e)" size="sm" [class.dir]="e.kind === 'dir'" /><span class="item__name">{{ e.name }}</span><span class="item__meta muted">{{ parent(e.path) }}</span></button></li>
                  }
                </ul>
                <a class="more" href="/starred" (click)="go($event, '/starred')">All starred</a>
              }
            }
          </section>
          @if (drive.shared().length) {
            <section>
              <h2>Shared with you</h2>
              <ul class="list">
                @for (s of drive.shared().slice(0, 8); track s.id) {
                  <li><button type="button" class="item" (click)="go($event, '/shared')"><mk-icon [name]="s.kind === 'file' ? 'file-text' : 'folder'" size="sm" [class.dir]="s.kind !== 'file'" /><span class="item__name">{{ s.name }}</span><span class="item__meta muted">by {{ s.owner.name }}</span></button></li>
                }
              </ul>
              <a class="more" href="/shared" (click)="go($event, '/shared')">Everything shared with you</a>
            </section>
          }
        </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .center {
        display: grid;
        place-items: center;
        min-height: 60vh;
      }
      .page {
        max-width: 960px;
        margin: 0 auto;
        padding: var(--mk-space-5) var(--mk-space-4) var(--mk-space-10);
      }
      .find {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        margin-bottom: var(--mk-space-5);
      }
      .find__icon {
        color: var(--mk-text-muted);
        flex: none;
      }
      .find__input {
        flex: 1;
        min-width: 0;
      }
      .find__mode {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-1);
        font-size: var(--mk-font-size-xs);
        white-space: nowrap;
        cursor: pointer;
      }
      .row__icon--dir {
        color: var(--mk-primary);
      }
      .row__snippet {
        font-size: var(--mk-font-size-xs);
        font-style: italic;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .places {
        display: flex;
        gap: var(--mk-space-2);
        overflow-x: auto;
        padding-bottom: var(--mk-space-2);
        margin-bottom: var(--mk-space-6);
        scrollbar-width: thin;
      }
      .place {
        flex: 0 0 auto;
        display: grid;
        grid-template-columns: auto 1fr;
        grid-template-rows: auto auto auto;
        column-gap: var(--mk-space-2);
        row-gap: 4px;
        align-items: center;
        min-width: 160px;
        max-width: 220px;
        padding: var(--mk-space-2) var(--mk-space-3);
        border-radius: var(--mk-radius-md);
        border: 1px solid var(--mk-border-subtle);
        color: inherit;
        text-decoration: none;
      }
      .place:hover {
        border-color: var(--mk-border-strong);
      }
      .place:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
      }
      .place__icon {
        color: var(--mk-primary);
        grid-row: 1;
      }
      .place__name {
        grid-row: 1;
        font-weight: 600;
        font-size: var(--mk-font-size-sm);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .place__bar {
        grid-column: 1 / -1;
        display: block;
        height: 4px;
        border-radius: 999px;
        background: var(--mk-border-subtle);
        overflow: hidden;
      }
      .place__bar span {
        display: block;
        height: 100%;
        background: var(--mk-primary);
        border-radius: inherit;
      }
      .place__meta {
        grid-column: 1 / -1;
        font-size: var(--mk-font-size-xs);
        white-space: nowrap;
      }
      h1 {
        margin: 0;
        font-size: var(--mk-font-size-2xl);
        letter-spacing: -0.01em;
      }
      .lead {
        margin: var(--mk-space-1) 0 var(--mk-space-4);
        max-width: 60ch;
      }
      .feed {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--mk-border-subtle);
      }
      .feed li {
        border-bottom: 1px solid var(--mk-border-subtle);
      }
      .row {
        display: grid;
        grid-template-columns: 40px 1fr auto auto auto;
        align-items: center;
        gap: var(--mk-space-3);
        width: 100%;
        padding: var(--mk-space-2) var(--mk-space-2);
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        border-radius: var(--mk-radius-md);
      }
      .row:hover {
        background: var(--mk-surface-2);
      }
      .row:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
      }
      .row__media {
        position: relative;
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: var(--mk-radius-sm);
        background: var(--mk-surface-2);
        overflow: hidden;
      }
      .row__media img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .row__media img[hidden] {
        display: none;
      }
      .row__media img + .row__icon {
        visibility: hidden;
      }
      .row__media img[hidden] + .row__icon {
        visibility: visible;
      }
      .row__icon {
        color: var(--mk-text-muted);
      }
      .row__text {
        min-width: 0;
        display: grid;
      }
      .row__name {
        font-size: var(--mk-font-size-sm);
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row__where,
      .row__by,
      .row__size,
      .row__when {
        font-size: var(--mk-font-size-xs);
        white-space: nowrap;
      }
      .row__where {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row__when {
        min-width: 5.5em;
        text-align: right;
      }
      .columns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: var(--mk-space-6);
        margin-top: var(--mk-space-8);
      }
      h2 {
        margin: 0 0 var(--mk-space-2);
        font-size: var(--mk-font-size-md);
        font-weight: 600;
      }
      .note {
        margin: 0;
        font-size: var(--mk-font-size-sm);
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .item {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        width: 100%;
        padding: 6px var(--mk-space-2);
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        font-size: var(--mk-font-size-sm);
        text-align: left;
        cursor: pointer;
        border-radius: var(--mk-radius-sm);
      }
      .item:hover {
        background: var(--mk-surface-2);
      }
      .item:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
      }
      .item mk-icon {
        color: var(--mk-text-muted);
        flex: none;
      }
      .item mk-icon.dir {
        color: var(--mk-primary);
      }
      .item__name {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item__meta {
        font-size: var(--mk-font-size-xs);
        white-space: nowrap;
        max-width: 45%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .more {
        display: inline-block;
        margin: var(--mk-space-2) var(--mk-space-2) 0;
        font-size: var(--mk-font-size-sm);
        color: var(--mk-primary);
        text-decoration: none;
      }
      .more:hover {
        text-decoration: underline;
      }
      @media (max-width: 640px) {
        .row {
          grid-template-columns: 40px 1fr auto;
        }
        .row__by,
        .row__size {
          display: none;
        }
      }
    `,
  ],
})
export class HomePage {
  protected readonly drive = inject(DriveService);
  protected readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly f = { ago, bytes };
  protected readonly icon = iconFor;
  protected readonly state = signal<'loading' | 'empty' | 'ready'>('loading');
  protected readonly arrivals = signal<Arrival[] | null>(null);
  protected readonly recent = signal<MarkedEntry[] | null>(null);
  protected readonly starred = signal<MarkedEntry[] | null>(null);
  /** The drive-wide search: what was typed, whether to look inside files, and what came back. */
  protected readonly query = signal('');
  protected readonly inFiles = signal(false);
  protected readonly results = signal<SearchResult | null>(null);
  protected readonly searchError = signal<string | null>(null);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** One sentence about what arrived, written from the list itself. */
  protected readonly summary = computed(() => {
    const list = this.arrivals();
    if (!list) return 'Looking for what arrived lately…';
    if (!list.length) return 'Your uploads, and what people send you through file-request links.';
    const now = Date.now();
    const week = list.filter((a) => now - a.at < WEEK);
    const links = week.filter((a) => a.viaLink).length;
    if (!week.length) return `Nothing new this week. The last file arrived ${ago(list[0].at)}.`;
    const n = week.length === list.length ? `${week.length}${list.length >= 30 ? '+' : ''}` : String(week.length);
    return `${n} file${week.length === 1 ? '' : 's'} arrived this week${links ? `, ${links} of them through your links` : ''}.`;
  });

  constructor() {
    void this.start();
    effect(() => {
      const q = this.query().trim();
      const inFiles = this.inFiles();
      untracked(() => {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.results.set(null);
        this.searchError.set(null);
        if (!q) return;
        this.searchTimer = setTimeout(() => void this.runSearch(q, inFiles), 350);
      });
    });
  }

  private async runSearch(q: string, inFiles: boolean): Promise<void> {
    try {
      const r = await this.api.search('', q, false, inFiles);
      if (this.query().trim() === q && this.inFiles() === inFiles) this.results.set(r);
    } catch (e) {
      this.searchError.set(errorMessage(e));
    }
  }

  private async start(): Promise<void> {
    await this.drive.ready();
    if (this.drive.meta()?.setupRequired) {
      await this.router.navigate(['/setup']);
      return;
    }
    if (!this.drive.signedIn()) {
      await this.router.navigate(['/login']);
      return;
    }
    if (!this.drive.locations().length && !this.drive.shared().length) {
      this.state.set('empty');
      return;
    }
    this.state.set('ready');
    void this.api.arrivals().then((a) => this.arrivals.set(a)).catch(() => this.arrivals.set([]));
    void this.api.recent().then((r) => this.recent.set(r.slice(0, 8))).catch(() => this.recent.set([]));
    void this.api.stars().then((s) => this.starred.set(s.slice(0, 8))).catch(() => this.starred.set([]));
  }

  used(sp: { free: number; total: number }): number {
    return sp.total ? Math.min(100, Math.round(((sp.total - sp.free) / sp.total) * 100)) : 0;
  }

  parent(path: string): string {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path;
  }

  encode(name: string): string {
    return encodeURIComponent(name);
  }

  go(ev: Event, url: string): void {
    ev.preventDefault();
    void this.router.navigateByUrl(url);
  }

  open(e: Entry): void {
    const target = e.kind === 'dir' ? e.path : this.parent(e.path);
    void this.router.navigate(['/d', ...target.split('/')], e.kind === 'file' ? { queryParams: { open: e.name } } : {});
  }

}
