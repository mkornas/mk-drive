import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import { MkToastService } from '@mk-kit/ui/feedback';
import { DriveService } from '../core/drive.service';
import { OpsService } from '../core/ops.service';
import { UploaderService } from '../core/uploader.service';
import { bytes } from '../core/format';

const INBOX = 'mk-drive-share-inbox';
const DEST_KEY = 'mk-drive.share.dest';

interface Parked {
  key: string;
  name: string;
  type: string;
  size: number;
  mtime: number;
}

/** What the phone's share sheet sent to the installed app: pick a folder, upload, done. */
@Component({
  selector: 'app-receive',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkEmptyState, MkSpinner],
  template: `
    <div class="page page--narrow">
      <header class="head">
        <h1><mk-icon name="upload" /> Save to the drive</h1>
        <p class="muted">Files shared to the app wait here until you choose where they go.</p>
      </header>
      @if (items() === null) {
        <mk-spinner />
      } @else if (items()!.length === 0) {
        <mk-empty-state icon="share" title="Nothing to save" description="Share a photo or a file to mk-drive from another app and it shows up here. On a phone that needs the app installed from the browser menu." />
      } @else {
        <ul class="list">
          @for (it of items(); track it.key) {
            <li class="item">
              <mk-icon [name]="it.type.startsWith('image/') ? 'image' : it.type.startsWith('video/') ? 'video' : 'file'" size="sm" class="muted" />
              <span class="item__name">{{ it.name }}</span>
              <span class="muted small">{{ f.bytes(it.size) }}</span>
            </li>
          }
        </ul>
        <div class="dest">
          <span class="muted">Into</span>
          <button mkButton variant="outline" (click)="pick()"><mk-icon name="folder-open" size="sm" /> {{ dest() || 'choose a folder' }}</button>
        </div>
        <div class="actions">
          <button mkButton [disabled]="!dest() || busy()" [loading]="busy()" (click)="save()"><mk-icon name="upload" size="sm" /> Upload {{ items()!.length }} {{ items()!.length === 1 ? 'file' : 'files' }}</button>
          <button mkButton variant="ghost" (click)="discard()">Discard</button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .head {
        margin-bottom: var(--mk-space-5);
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
      .list {
        list-style: none;
        margin: 0 0 var(--mk-space-4);
        padding: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .item {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        padding: var(--mk-space-2) var(--mk-space-3);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface);
      }
      .item__name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .dest,
      .actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
        margin-bottom: var(--mk-space-4);
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class ReceivePage {
  private readonly drive = inject(DriveService);
  private readonly ops = inject(OpsService);
  private readonly uploader = inject(UploaderService);
  private readonly toast = inject(MkToastService);
  private readonly router = inject(Router);
  protected readonly f = { bytes };
  protected readonly items = signal<Parked[] | null>(null);
  protected readonly dest = signal<string>(readDest());
  protected readonly busy = signal(false);
  protected readonly writable = computed(() => this.drive.locations().filter((l) => l.access === 'write'));

  constructor() {
    void this.drive.ready().then(() => {
      if (!this.dest() || !this.writable().some((l) => this.dest() === l.name || this.dest().startsWith(l.name + '/'))) this.dest.set(this.writable()[0]?.name ?? '');
    });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const cache = await caches.open(INBOX);
      const out: Parked[] = [];
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (!res) continue;
        const blob = await res.clone().blob();
        out.push({ key: req.url, name: decodeURIComponent(res.headers.get('x-name') ?? 'shared'), type: res.headers.get('content-type') ?? '', size: blob.size, mtime: Number(res.headers.get('x-mtime')) || Date.now() });
      }
      this.items.set(out.sort((a, b) => a.key.localeCompare(b.key)));
    } catch {
      this.items.set([]);
    }
  }

  async pick(): Promise<void> {
    const to = await this.ops.pickFolder({ title: 'Save into', confirmText: 'Save here', start: this.dest() || this.writable()[0]?.name || '' });
    if (to) this.dest.set(to);
  }

  async save(): Promise<void> {
    const dir = this.dest();
    const list = this.items();
    if (!dir || !list?.length) return;
    this.busy.set(true);
    try {
      const cache = await caches.open(INBOX);
      const files: { file: File; dir: string; name: string }[] = [];
      for (const it of list) {
        const res = await cache.match(it.key);
        if (!res) continue;
        const blob = await res.blob();
        files.push({ file: new File([blob], it.name, { type: it.type, lastModified: it.mtime }), dir, name: it.name });
      }
      this.uploader.add(files);
      for (const it of list) await cache.delete(it.key);
      try {
        localStorage.setItem(DEST_KEY, dir);
      } catch {
        /* fine */
      }
      this.toast.success(`Uploading ${files.length} ${files.length === 1 ? 'file' : 'files'} into ${dir}`);
      await this.router.navigate(['/d', ...dir.split('/')]);
    } catch (e) {
      this.toast.danger((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async discard(): Promise<void> {
    const cache = await caches.open(INBOX);
    for (const req of await cache.keys()) await cache.delete(req);
    this.items.set([]);
  }
}

function readDest(): string {
  try {
    return localStorage.getItem(DEST_KEY) ?? '';
  } catch {
    return '';
  }
}
