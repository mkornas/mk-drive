import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import { MkToastService } from '@mk-kit/ui/feedback';
import { MkLightboxService } from '@mk-kit/ui/media';
import { MkDrawer } from '@mk-kit/ui/navigation';
import type { Entry, PhotoPage } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { kindOf } from '../core/file-kind';
import { Preview } from '../shared/preview';

interface Group {
  key: string;
  label: string;
  entries: Entry[];
}

const LOCATION_KEY = 'mk-drive.photos.location';

/** Every image and video of a location on one scrolling timeline, newest first, grouped by day. */
@Component({
  selector: 'app-photos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkSelect, MkEmptyState, MkSpinner, MkDrawer, Preview],
  template: `
    <div class="page page--wide">
      <header class="head">
        <div>
          <h1><mk-icon name="image" /> Photos</h1>
          <p class="muted">Pictures and videos from everywhere in a location, newest first — by the date they were taken when the file says so.</p>
        </div>
        <div class="head__actions">
          @if (locationOptions().length > 1) {
            <mk-select [options]="locationOptions()" [(value)]="location" aria-label="Location" class="loc" />
          }
          <button mkButton variant="ghost" size="sm" iconOnly [loading]="loading()" aria-label="Refresh" (click)="refresh()"><mk-icon name="refresh-cw" size="sm" /></button>
        </div>
      </header>

      @if (page() === null && loading()) {
        <mk-spinner />
      } @else if (groups().length === 0) {
        <mk-empty-state
          icon="image"
          title="No pictures here yet"
          [description]="
            page()?.truncated
              ? 'The walk stopped early — this location is very large.'
              : 'Upload some photos or videos into ' + (location() || 'a location') + ' and they show up here.'
          "
        />
      } @else {
        @for (g of groups(); track g.key) {
          <section class="day">
            <h2 class="day__title">
              {{ g.label }} <span class="muted day__count">{{ g.entries.length }}</span>
            </h2>
            <div class="grid">
              @for (e of g.entries; track e.path) {
                <button
                  type="button"
                  class="tile"
                  [class.tile--video]="isVideo(e)"
                  (click)="open(e)"
                  [attr.aria-label]="e.name"
                  [title]="e.name + ' · ' + e.path"
                >
                  @if (e.thumb) {
                    <img [src]="api.thumbUrl(e.path, 320)" [alt]="" loading="lazy" decoding="async" (error)="$any($event.target).hidden = true" />
                  } @else {
                    <mk-icon [name]="isVideo(e) ? 'video' : 'image'" size="lg" class="tile__icon" />
                  }
                  @if (isVideo(e)) {
                    <mk-icon name="play" size="sm" class="tile__badge" />
                  }
                </button>
              }
            </div>
          </section>
        }
        <div class="more">
          @if (page()?.next) {
            <button mkButton variant="outline" [loading]="loading()" (click)="more()">Older</button>
          } @else {
            <span class="muted small"
              >{{ all().length }} of {{ page()?.total }}{{ page()?.truncated ? ' — the walk stopped early, this location is very large' : '' }}</span
            >
          }
        </div>
      }
    </div>

    <mk-drawer [(open)]="previewOpen" side="end" size="min(56rem, 100vw)" [heading]="previewEntry()?.name ?? ''">
      <app-preview [entry]="previewOpen() ? previewEntry() : null" />
    </mk-drawer>
  `,
  styles: [
    `
      .page--wide {
        max-width: none;
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--mk-space-4);
        margin-bottom: var(--mk-space-5);
        flex-wrap: wrap;
      }
      h1 {
        font-size: var(--mk-font-size-2xl);
        margin: 0 0 var(--mk-space-1);
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
      }
      p {
        margin: 0;
      }
      .head__actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
      }
      .loc {
        min-width: 12rem;
      }
      .day {
        margin-bottom: var(--mk-space-6);
      }
      .day__title {
        position: sticky;
        top: 0;
        z-index: 1;
        margin: 0 0 var(--mk-space-3);
        padding: var(--mk-space-2) 0;
        font-size: var(--mk-font-size-md);
        font-weight: 600;
        background: var(--mk-bg);
      }
      .day__count {
        font-weight: 400;
        font-size: var(--mk-font-size-sm);
        margin-left: var(--mk-space-2);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 4px;
      }
      .tile {
        position: relative;
        aspect-ratio: 1;
        padding: 0;
        border: 0;
        border-radius: var(--mk-radius-sm);
        overflow: hidden;
        background: var(--mk-surface);
        cursor: pointer;
        display: grid;
        place-items: center;
      }
      .tile img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .tile:hover img {
        filter: brightness(1.06);
      }
      .tile:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
        outline-offset: -3px;
      }
      .tile__icon {
        color: var(--mk-text-muted);
      }
      .tile__badge {
        position: absolute;
        right: 6px;
        bottom: 6px;
        color: #fff;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
      }
      .more {
        display: flex;
        justify-content: center;
        padding: var(--mk-space-4) 0 var(--mk-space-8);
      }
      .small {
        font-size: var(--mk-font-size-sm);
      }
      @media (max-width: 640px) {
        .grid {
          grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
          gap: 2px;
        }
      }
    `,
  ],
})
export class PhotosPage {
  protected readonly drive = inject(DriveService);
  protected readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly lightbox = inject(MkLightboxService);
  protected readonly location = signal<string>(readSaved());
  protected readonly locationOptions = computed<MkSelectOption[]>(() => this.drive.locations().map((l) => ({ label: l.name, value: l.name })));
  protected readonly page = signal<PhotoPage | null>(null);
  protected readonly all = signal<Entry[]>([]);
  protected readonly loading = signal(false);
  protected readonly previewOpen = signal(false);
  protected readonly previewEntry = signal<Entry | null>(null);
  protected readonly groups = computed<Group[]>(() => {
    const out: Group[] = [];
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    for (const e of this.all()) {
      const d = new Date(e.taken ?? e.mtime);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.entries.push(e);
      else out.push({ key, label: fmt.format(d), entries: [e] });
    }
    return out;
  });

  constructor() {
    void this.drive.ready().then(() => {
      const names = this.drive.locations().map((l) => l.name);
      if (!names.includes(this.location())) this.location.set(names[0] ?? '');
    });
    effect(() => {
      const loc = this.location();
      untracked(() => {
        if (!loc) return;
        try {
          localStorage.setItem(LOCATION_KEY, loc);
        } catch {
          /* fine */
        }
        this.all.set([]);
        this.page.set(null);
        void this.load(loc, null);
      });
    });
  }

  refresh(): void {
    this.all.set([]);
    this.page.set(null);
    void this.load(this.location(), null, true);
  }

  private async load(loc: string, before: number | null, fresh = false): Promise<void> {
    this.loading.set(true);
    try {
      const p = await this.api.photos(loc, before, 200, fresh);
      if (this.location() !== loc) return;
      this.page.set(p);
      this.all.update((a) => (before === null ? p.entries : [...a, ...p.entries]));
    } catch (e) {
      this.toast.danger(errorMessage(e));
      this.page.set({ entries: [], next: null, total: 0, truncated: false, scannedAt: 0 });
    } finally {
      this.loading.set(false);
    }
  }

  more(): void {
    const next = this.page()?.next;
    if (next) void this.load(this.location(), next);
  }

  isVideo(e: Entry): boolean {
    return kindOf(e) === 'video';
  }

  /** Images open in the lightbox with everything loaded so far; a video opens in the preview drawer. */
  open(e: Entry): void {
    void this.api.touchRecent(e.path).catch(() => {});
    if (this.isVideo(e)) {
      this.previewEntry.set(e);
      this.previewOpen.set(true);
      return;
    }
    const images = this.all().filter((x) => !this.isVideo(x));
    const index = Math.max(
      0,
      images.findIndex((x) => x.path === e.path),
    );
    this.lightbox.open(
      images.map((x) => ({ src: this.api.fileUrl(x.path), alt: x.name, caption: x.name })),
      index,
    );
  }
}

function readSaved(): string {
  try {
    return localStorage.getItem(LOCATION_KEY) ?? '';
  } catch {
    return '';
  }
}
