import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkFormField, MkPasswordInput } from '@mk-kit/ui/forms';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import { MkProgressBar } from '@mk-kit/ui/data';
import { MkBreadcrumb, MkBreadcrumbItem } from '@mk-kit/ui/navigation';
import { MkLightboxService } from '@mk-kit/ui/media';
import { MkCode, MkMarkdown } from '@mk-kit/ui/data';
import { filesFromDataTransfer, sendFile } from '../core/uploader.service';
import type { Entry, Listing, ShareInfo } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { bytes, dateTime } from '../core/format';
import { iconClass, iconFor, kindOf } from '../core/file-kind';
import { AuthCard } from '../shared/auth-card';

/** One file a visitor sends through a file request. */
interface Send {
  id: number;
  file: File;
  state: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';
  sent: number;
  error?: string;
  /** The name it got in the folder (a taken name gets a numbered sibling). */
  name?: string;
}

/** The public face of a share link: no account, no shell — just the thing that was shared. */
@Component({
  selector: 'app-share',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkFormField, MkPasswordInput, MkEmptyState, MkSpinner, MkProgressBar, MkBreadcrumb, MkBreadcrumbItem, MkCode, MkMarkdown, AuthCard],
  host: { '(window:beforeunload)': 'onLeave($event)' },
  template: `
    @if (state() === 'loading') {
      <div class="center"><mk-spinner /></div>
    } @else if (state() === 'gone') {
      <div class="center"><mk-empty-state icon="link-off" title="This link is not available" [description]="error() ?? 'It may have expired or been removed.'" /></div>
    } @else if (info(); as i) {
      @if (!i.open) {
        <app-auth-card [title]="i.name" lead="This link is protected. Enter the password you were given.">
          <form class="form" (submit)="unlock($event)">
            <mk-form-field label="Password" [error]="error()">
              <mk-password-input [(value)]="password" autocomplete="off" />
            </mk-form-field>
            <button mkButton type="submit" fullWidth [loading]="busy()" [disabled]="!password()">Open</button>
          </form>
        </app-auth-card>
      } @else {
        <div class="page">
          <header class="head">
            <span class="mark" aria-hidden="true"><mk-icon [name]="i.mode === 'upload' ? 'cloud-upload' : 'folder'" size="sm" /></span>
            <div class="head__text">
              <h1>{{ i.name }}</h1>
              <p class="muted">{{ i.kind === 'dir' ? (i.mode === 'upload' ? 'File request · what you add goes straight to the owner' : 'Shared folder') : f.bytes(i.size) + ' · ' + f.dateTime(i.mtime) }}@if (i.expiresAt) { · link expires {{ f.dateTime(i.expiresAt) }}}</p>
            </div>
            @if (i.mode !== 'upload') {
              <div class="head__actions">
                @if (i.kind === 'file') {
                  <a mkButton [href]="api.shareFileUrl(i.id, '', true)" download><mk-icon name="download" size="sm" /> Download</a>
                } @else {
                  <a mkButton [href]="api.shareZipUrl(i.id, i.mode === 'browse' ? path() : '')" download><mk-icon name="download" size="sm" /> Download {{ path() ? 'this folder' : 'all' }} as zip</a>
                }
              </div>
            }
          </header>

          @if (i.kind === 'file') {
            <div class="stage" [class.stage--media]="kind() === 'image' || kind() === 'video'">
              @switch (kind()) {
                @case ('image') { <img [src]="api.shareFileUrl(i.id)" [alt]="i.name" /> }
                @case ('video') { <video controls preload="metadata" [src]="api.shareFileUrl(i.id)"></video> }
                @case ('audio') { <audio controls preload="metadata" [src]="api.shareFileUrl(i.id)"></audio> }
                @case ('pdf') { <iframe [src]="pdfUrl()" [title]="i.name"></iframe> }
                @case ('markdown') {
                  @if (text() !== null) { <div class="doc"><mk-markdown [source]="text()!" /></div> } @else { <mk-spinner /> }
                }
                @case ('json') {
                  @if (text() !== null) { <mk-code [code]="text()!" language="json" [filename]="i.name" lineNumbers wrap /> } @else { <mk-spinner /> }
                }
                @case ('text') {
                  @if (text() !== null) { <mk-code [code]="text()!" language="plaintext" [filename]="i.name" lineNumbers wrap /> } @else { <mk-spinner /> }
                }
                @default { <mk-empty-state [icon]="icon(i)" [title]="i.name" description="Download it to open it on your device." /> }
              }
            </div>
          } @else if (i.mode === 'upload') {
            <div class="drop" [class.drop--over]="over()" (dragover)="onDragOver($event)" (dragleave)="over.set(false)" (drop)="onDrop($event)">
              <mk-icon name="cloud-upload" size="lg" class="drop__icon" />
              <p class="drop__title">Drop files here</p>
              <p class="muted">They land in the owner's folder. You will not see what is already there.</p>
              <button mkButton (click)="picker.click()"><mk-icon name="upload" size="sm" /> Choose files</button>
              <input #picker type="file" multiple hidden (change)="onPick($event)" />
            </div>
            @if (sends().length) {
              <ul class="sends" aria-label="Files">
                @for (s of sends(); track s.id) {
                  <li class="send" [class.send--bad]="s.state === 'failed'">
                    <mk-icon [name]="s.state === 'done' ? 'check' : s.state === 'failed' ? 'circle-alert' : 'file-text'" size="sm" class="send__icon" [class.send__icon--ok]="s.state === 'done'" />
                    <div class="send__main">
                      <div class="send__name">{{ s.file.name }}</div>
                      @if (s.state === 'uploading') {
                        <mk-progress-bar size="sm" [value]="(s.sent / (s.file.size || 1)) * 100" />
                      }
                      <div class="muted small">{{ sendLabel(s) }}</div>
                    </div>
                    @if (s.state === 'uploading' || s.state === 'queued') {
                      <button mkButton variant="ghost" size="sm" iconOnly aria-label="Cancel" (click)="cancelSend(s)"><mk-icon name="close" size="sm" /></button>
                    }
                  </li>
                }
              </ul>
            }
          } @else if (i.mode !== 'browse') {
            <mk-empty-state icon="archive" title="Download to see what is inside" description="This link hands out the whole folder as one zip file." />
          } @else {
            <mk-breadcrumb class="crumbs">
              <mk-breadcrumb-item [href]="path() ? '?' : undefined" (click)="path() ? go($event, '') : null">{{ i.name }}</mk-breadcrumb-item>
              @for (c of crumbs(); track c.path) {
                <mk-breadcrumb-item [href]="c.last ? undefined : '?'" (click)="c.last ? null : go($event, c.path)">{{ c.label }}</mk-breadcrumb-item>
              }
            </mk-breadcrumb>
            @if (listing(); as l) {
              @if (l.entries.length === 0) {
                <mk-empty-state icon="folder-open" title="Empty folder" />
              } @else {
                <div class="grid" role="list">
                  @for (e of l.entries; track e.path) {
                    <button type="button" class="card" role="listitem" (click)="openEntry(e)">
                      <span class="card__media">
                        @if (e.thumb) {
                          <img [src]="api.shareThumbUrl(i.id, e.path, 320)" alt="" loading="lazy" (error)="$any($event.target).hidden = true" />
                        }
                        <mk-icon [name]="icon(e)" size="lg" [class]="iconClass(e, 'card__icon')" />
                      </span>
                      <span class="card__name">{{ e.name }}</span>
                      <span class="card__meta muted">{{ e.kind === 'dir' ? 'folder' : f.bytes(e.size) }}</span>
                    </button>
                  }
                </div>
              }
            } @else {
              <div class="center"><mk-spinner /></div>
            }
          }
          <p class="foot muted">Shared with mk-drive</p>
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100dvh;
      }
      .center {
        display: grid;
        place-items: center;
        min-height: 60vh;
      }
      .form {
        display: grid;
        gap: var(--mk-space-4);
      }
      .page {
        max-width: 1100px;
        margin: 0 auto;
        padding: var(--mk-space-6) var(--mk-space-4) var(--mk-space-10);
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
        margin-bottom: var(--mk-space-5);
      }
      .mark {
        display: inline-grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border-radius: var(--mk-radius-md);
        background: var(--mk-primary);
        color: var(--mk-primary-contrast);
        flex: none;
      }
      .head__text {
        flex: 1;
        min-width: 0;
      }
      .head__text h1 {
        margin: 0;
        font-size: var(--mk-font-size-xl);
        overflow-wrap: anywhere;
      }
      .head__text p {
        margin: 2px 0 0;
        font-size: var(--mk-font-size-sm);
      }
      .stage {
        display: grid;
        place-items: center;
        min-height: 240px;
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface-2);
        overflow: hidden;
      }
      .stage--media {
        background: color-mix(in srgb, var(--mk-text) 92%, var(--mk-bg));
      }
      .stage > img,
      .stage > video {
        max-width: 100%;
        max-height: 80vh;
        object-fit: contain;
      }
      .stage > audio {
        width: 100%;
        margin: var(--mk-space-4);
      }
      .stage > iframe {
        width: 100%;
        height: 80vh;
        border: 0;
      }
      .stage > mk-code {
        width: 100%;
        max-height: 80vh;
        overflow: auto;
        justify-self: stretch;
      }
      .doc {
        width: 100%;
        padding: var(--mk-space-5);
        box-sizing: border-box;
        justify-self: stretch;
        background: var(--mk-surface);
      }
      .crumbs {
        margin-bottom: var(--mk-space-4);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: var(--mk-space-3);
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: var(--mk-space-1);
        padding: var(--mk-space-2);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .card:hover {
        border-color: var(--mk-border-strong);
      }
      .card:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
      }
      .card__media {
        position: relative;
        display: grid;
        place-items: center;
        aspect-ratio: 4 / 3;
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface-2);
        overflow: hidden;
      }
      .card__media img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .card__media img[hidden] {
        display: none;
      }
      .card__media img + .card__icon {
        visibility: hidden;
      }
      .card__media img[hidden] + .card__icon {
        visibility: visible;
      }
      .card__icon {
        color: var(--mk-text-muted);
      }
      .card__icon--dir {
        color: var(--mk-primary);
      }
      .card__name {
        font-size: var(--mk-font-size-sm);
        overflow-wrap: anywhere;
        padding: 0 4px;
      }
      .card__meta {
        font-size: var(--mk-font-size-xs);
        padding: 0 4px 4px;
      }
      .drop {
        display: grid;
        justify-items: center;
        gap: var(--mk-space-2);
        padding: var(--mk-space-8) var(--mk-space-4);
        border: 2px dashed var(--mk-border-strong);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
        text-align: center;
        transition: border-color 0.15s, background 0.15s;
      }
      .drop--over {
        border-color: var(--mk-primary);
        background: color-mix(in srgb, var(--mk-primary) 8%, var(--mk-surface));
      }
      .drop__icon {
        color: var(--mk-primary);
      }
      .drop__title {
        margin: 0;
        font-size: var(--mk-font-size-lg);
        font-weight: 600;
      }
      .drop p {
        margin: 0;
      }
      .drop button {
        margin-top: var(--mk-space-2);
      }
      .sends {
        list-style: none;
        margin: var(--mk-space-4) 0 0;
        padding: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .send {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        padding: var(--mk-space-2) var(--mk-space-3);
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface);
      }
      .send--bad {
        color: var(--mk-danger);
      }
      .send__icon {
        color: var(--mk-text-muted);
        flex: none;
      }
      .send__icon--ok {
        color: var(--mk-success);
      }
      .send__main {
        flex: 1;
        min-width: 0;
        display: grid;
        gap: 4px;
      }
      .send__name {
        font-size: var(--mk-font-size-sm);
        overflow-wrap: anywhere;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .foot {
        margin-top: var(--mk-space-8);
        font-size: var(--mk-font-size-sm);
        text-align: center;
      }
    `,
  ],
})
export class SharePage {
  protected readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly lightbox = inject(MkLightboxService);
  protected readonly f = { bytes, dateTime };
  protected readonly icon = iconFor;
  protected readonly iconClass = iconClass;
  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), { initialValue: '' });
  protected readonly info = signal<ShareInfo | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'gone'>('loading');
  protected readonly error = signal<string | null>(null);
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  /** Folder path inside the share (browse mode). */
  protected readonly path = signal('');
  protected readonly listing = signal<Listing | null>(null);
  protected readonly text = signal<string | null>(null);
  /** File request: what the visitor is sending, in order. */
  protected readonly sends = signal<Send[]>([]);
  protected readonly over = signal(false);
  private sendSeq = 0;
  private sending = 0;
  private readonly aborts = new Map<number, AbortController>();
  protected readonly kind = computed(() => (this.info() ? kindOf({ kind: this.info()!.kind, mime: this.info()!.mime }) : 'other'));
  protected readonly pdfUrl = computed(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.info() ? this.api.shareFileUrl(this.info()!.id) : ''));
  protected readonly crumbs = computed(() => {
    const parts = this.path().split('/').filter(Boolean);
    return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/'), last: i === parts.length - 1 }));
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
    effect(() => {
      const i = this.info();
      const path = this.path();
      untracked(() => {
        if (i?.open && i.kind === 'dir' && i.mode === 'browse') void this.list(path);
        const k = this.kind();
        if (i?.open && i.kind === 'file' && (k === 'text' || k === 'json' || k === 'markdown')) void this.loadText(i.id);
      });
    });
  }

  // ---- file request: the visitor's side ----

  protected onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.over.set(true);
  }

  protected async onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    this.over.set(false);
    if (!ev.dataTransfer) return;
    // folders are flattened: a file request takes files, not trees
    this.queue((await filesFromDataTransfer(ev.dataTransfer)).map((f) => f.file));
  }

  protected onPick(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    this.queue([...(input.files ?? [])]);
    input.value = '';
  }

  protected sendLabel(s: Send): string {
    switch (s.state) {
      case 'queued':
        return 'waiting';
      case 'uploading':
        return `${bytes(s.sent)} of ${bytes(s.file.size)}`;
      case 'done':
        return s.name && s.name !== s.file.name ? `sent as ${s.name}` : 'sent';
      case 'failed':
        return s.error ?? 'failed';
      default:
        return 'cancelled';
    }
  }

  protected cancelSend(s: Send): void {
    this.aborts.get(s.id)?.abort();
    this.patchSend(s.id, { state: 'cancelled' });
  }

  protected onLeave(ev: BeforeUnloadEvent): void {
    if (this.sends().some((s) => s.state === 'queued' || s.state === 'uploading')) ev.preventDefault();
  }

  private queue(files: File[]): void {
    if (!files.length) return;
    const next = files.map<Send>((file) => ({ id: ++this.sendSeq, file, state: 'queued', sent: 0 }));
    this.sends.update((l) => [...l, ...next]);
    this.pumpSends();
  }

  private patchSend(id: number, p: Partial<Send>): void {
    this.sends.update((l) => l.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }

  private pumpSends(): void {
    while (this.sending < 2) {
      const next = this.sends().find((s) => s.state === 'queued');
      if (!next) return;
      this.sending++;
      void this.runSend(next).finally(() => {
        this.sending--;
        this.pumpSends();
      });
    }
  }

  private async runSend(s: Send): Promise<void> {
    const ctrl = new AbortController();
    this.aborts.set(s.id, ctrl);
    this.patchSend(s.id, { state: 'uploading' });
    try {
      const done = await sendFile(this.api.shareUploads(this.id()), s.file, '', s.file.name, 'rename', ctrl.signal, (sent) => this.patchSend(s.id, { sent }));
      this.patchSend(s.id, { state: 'done', sent: s.file.size, name: done.name });
    } catch (e) {
      const cancelled = (e as Error).message === 'cancelled';
      this.patchSend(s.id, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : errorMessage(e) });
    } finally {
      this.aborts.delete(s.id);
    }
  }

  private async load(id: string): Promise<void> {
    if (!id) return;
    try {
      this.info.set(await this.api.shareInfo(id));
      this.state.set('ready');
    } catch (e) {
      this.error.set(errorMessage(e));
      this.state.set('gone');
    }
  }

  private async loadText(id: string): Promise<void> {
    try {
      const res = await fetch(this.api.shareFileUrl(id), { headers: { Range: 'bytes=0-524287' } });
      this.text.set(await res.text());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  private async list(path: string): Promise<void> {
    this.listing.set(null);
    try {
      this.listing.set(await this.api.shareLs(this.id(), path));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async unlock(ev: Event): Promise<void> {
    ev.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.shareUnlock(this.id(), this.password());
      this.info.update((i) => (i ? { ...i, open: true } : i));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  go(ev: Event, path: string): void {
    ev.preventDefault();
    this.path.set(path);
  }

  openEntry(e: Entry): void {
    if (e.kind === 'dir') {
      this.path.set(e.path);
      return;
    }
    const id = this.id();
    if (kindOf(e) === 'image') {
      const images = (this.listing()?.entries ?? []).filter((x) => kindOf(x) === 'image');
      this.lightbox.open(
        images.map((x) => ({ src: this.api.shareFileUrl(id, x.path), alt: x.name, caption: x.name })),
        Math.max(0, images.findIndex((x) => x.path === e.path)),
      );
      return;
    }
    window.open(this.api.shareFileUrl(id, e.path), '_blank', 'noopener');
  }
}
