import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { MkHotkeysService } from '@mk-kit/ui/directives';
import { DomSanitizer } from '@angular/platform-browser';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkCode, MkDescItem, MkDescriptionList, MkMarkdown } from '@mk-kit/ui/data';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import type { Version } from '../../../../shared/types';
import { DriveService } from '../core/drive.service';
import { ago } from '../core/format';
import type { Entry } from '../../../../shared/types';
import { ApiService } from '../core/api.service';
import { bytes, dateTime } from '../core/format';
import { kindOf } from '../core/file-kind';

const TEXT_LIMIT = 512 * 1024;

/** Inline preview of one file: images, video, audio, PDF, markdown, JSON, text. */
@Component({
  selector: 'app-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, MkButton, MkIcon, MkCode, MkMarkdown, MkDescriptionList, MkDescItem, MkEmptyState, MkSpinner],
  template: `
    @if (entry(); as e) {
      <div class="stage" [class.stage--media]="kind() === 'image' || kind() === 'video'">
        @switch (kind()) {
          @case ('image') {
            <img [src]="url()" [alt]="e.name" />
          }
          @case ('video') {
            <video controls preload="metadata" [src]="url()" [poster]="e.thumb ? api.thumbUrl(e.path, 640) : null"></video>
          }
          @case ('audio') {
            <audio controls preload="metadata" [src]="url()"></audio>
          }
          @case ('pdf') {
            <iframe [src]="safeUrl()" [title]="e.name"></iframe>
          }
          @case ('markdown') {
            @if (editing()) {
              <ng-container *ngTemplateOutlet="editor" />
            } @else if (text(); as t) {
              <div class="doc"><mk-markdown [source]="t" /></div>
            } @else {
              <mk-spinner />
            }
          }
          @case ('json') {
            @if (editing()) {
              <ng-container *ngTemplateOutlet="editor" />
            } @else if (text() !== null) {
              <mk-code [code]="text()!" language="json" [filename]="e.name" lineNumbers wrap />
            } @else {
              <mk-spinner />
            }
          }
          @case ('text') {
            @if (editing()) {
              <ng-container *ngTemplateOutlet="editor" />
            } @else if (text() !== null) {
              <mk-code [code]="text()!" language="plaintext" [filename]="e.name" lineNumbers wrap />
            } @else {
              <mk-spinner />
            }
          }
          @default {
            <mk-empty-state icon="file" title="No preview" [description]="'Nothing here can show a ' + (e.mime || 'file') + ' — download it instead.'" />
          }
        }
        @if (truncated()) {
          <p class="muted note">Showing the first {{ f.bytes(limit) }} of this file.</p>
        }
        @if (editable() && !editing()) {
          <div class="edit-bar"><button mkButton variant="outline" size="sm" (click)="startEdit()"><mk-icon name="edit" size="sm" /> Edit</button></div>
        }
        @if (editing()) {
          <div class="edit-bar">
            <button mkButton size="sm" [loading]="saving()" [disabled]="!dirty()" (click)="save()"><mk-icon name="save" size="sm" /> Save <span class="muted kbd">⌘S</span></button>
            <button mkButton variant="ghost" size="sm" (click)="cancelEdit()">Cancel</button>
            @if (dirty()) {<span class="muted small">unsaved changes</span>}
          </div>
        }
        @if (textError(); as err) {
          <p class="muted note">Could not load the file: {{ err }}</p>
        }
      </div>
      <ng-template #editor>
        <textarea class="editor" [value]="draft()" (input)="draft.set($any($event.target).value)" spellcheck="false" [attr.aria-label]="'Editing ' + entry()?.name"></textarea>
      </ng-template>
      <mk-description-list layout="grid" class="details">
        <mk-desc-item term="Type">{{ e.mime || '—' }}</mk-desc-item>
        <mk-desc-item term="Size">{{ f.bytes(e.size) }}</mk-desc-item>
        @if (e.taken) {
          <mk-desc-item term="Taken">{{ f.dateTime(e.taken) }}</mk-desc-item>
        }
        <mk-desc-item term="Modified">{{ f.dateTime(e.mtime) }}</mk-desc-item>
        <mk-desc-item term="Path"><span class="mono">{{ e.path }}</span></mk-desc-item>
      </mk-description-list>
      <div class="actions">
        <a mkButton [href]="api.fileUrl(e.path, true)" download><mk-icon name="download" /> Download</a>
        <a mkButton variant="outline" [href]="url()" target="_blank" rel="noopener"><mk-icon name="external-link" /> Open in a tab</a>
      </div>
      @if (versions(); as vs) {
        @if (vs.length) {
          <section class="versions">
            <h3>Earlier versions</h3>
            <p class="muted small">From the filesystem's snapshots. Restoring keeps the current file and adds the old one next to it.</p>
            <ul>
              @for (v of vs; track v.snapshot) {
                <li class="version">
                  <span class="version__when">{{ v.at ? f.dateTime(v.at) : v.snapshot }}</span>
                  <span class="muted num">{{ f.bytes(v.size) }}</span>
                  <a mkButton variant="ghost" size="sm" [href]="api.versionUrl(e.path, v.snapshot, true)" download>Download</a>
                  @if (canWrite()) {
                    <button mkButton variant="ghost" size="sm" (click)="restore(e, v)">Restore</button>
                  }
                </li>
              }
            </ul>
          </section>
        }
      }
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--mk-space-4);
        min-height: 100%;
      }
      .stage {
        display: grid;
        place-items: center;
        min-height: 200px;
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface-muted, var(--mk-bg-muted));
        overflow: hidden;
      }
      .stage--media {
        background: color-mix(in srgb, var(--mk-text) 92%, var(--mk-bg));
      }
      .stage > img,
      .stage > video {
        max-width: 100%;
        max-height: 70vh;
        object-fit: contain;
      }
      .stage > audio {
        width: 100%;
        margin: var(--mk-space-4);
      }
      .stage > iframe {
        width: 100%;
        height: 75vh;
        border: 0;
      }
      .stage > mk-code {
        width: 100%;
        max-height: 70vh;
        overflow: auto;
        justify-self: stretch;
      }
      .doc {
        width: 100%;
        padding: var(--mk-space-5);
        justify-self: stretch;
        background: var(--mk-surface);
      }
      .note {
        font-size: var(--mk-font-size-sm);
        margin: var(--mk-space-2);
        justify-self: start;
      }
      .edit-bar {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        margin-top: var(--mk-space-3);
      }
      .kbd {
        font-size: var(--mk-font-size-xs);
      }
      .editor {
        width: 100%;
        min-height: 60vh;
        box-sizing: border-box;
        resize: vertical;
        padding: var(--mk-space-3);
        border: 1px solid var(--mk-border);
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface);
        color: var(--mk-text);
        font-family: var(--mk-font-mono);
        font-size: var(--mk-font-size-sm);
        line-height: 1.5;
        tab-size: 2;
      }
      .editor:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
        outline-offset: var(--mk-focus-ring-offset);
      }
      .actions {
        display: flex;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .versions h3 {
        font-size: var(--mk-font-size-sm);
        font-weight: 600;
        margin: 0 0 2px;
      }
      .versions .small {
        font-size: var(--mk-font-size-xs);
        margin: 0 0 var(--mk-space-2);
      }
      .versions ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .version {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        padding: var(--mk-space-1) 0;
        border-top: 1px solid var(--mk-border-subtle);
        font-size: var(--mk-font-size-sm);
      }
      .version__when {
        flex: 1;
      }
    `,
  ],
})
export class Preview {
  protected readonly api = inject(ApiService);
  private readonly sanitizer = inject(DomSanitizer);
  readonly entry = input<Entry | null>(null);
  /** Fires with the new path after a version was restored. */
  readonly restored = output<string>();
  /** Fires with the saved entry after an edit; the list refreshes its size and date. */
  readonly saved = output<Entry>();
  private readonly hotkeys = inject(MkHotkeysService);
  private readonly drive = inject(DriveService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly versions = signal<Version[] | null>(null);
  protected readonly canWrite = computed(() => {
    const path = this.entry()?.path ?? '';
    return this.drive.location(path.split('/')[0])?.access === 'write' || this.drive.sharedRootOf(path)?.level === 'write';
  });
  /** Text-like, small enough to load whole, and writable: the file can be edited in place. */
  protected readonly editable = computed(() => this.canWrite() && !this.truncated() && this.text() !== null && ['text', 'markdown', 'json'].includes(this.kind()));
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly saving = signal(false);
  protected readonly dirty = computed(() => this.editing() && this.draft() !== this.text());
  protected readonly f = { bytes, dateTime, ago };
  protected readonly limit = TEXT_LIMIT;

  protected readonly kind = computed(() => (this.entry() ? kindOf(this.entry()!) : 'other'));
  protected readonly url = computed(() => (this.entry() ? this.api.fileUrl(this.entry()!.path) : ''));
  protected readonly safeUrl = computed(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.url()));
  protected readonly text = signal<string | null>(null);
  protected readonly truncated = signal(false);
  protected readonly textError = signal<string | null>(null);

  constructor() {
    const off = this.hotkeys.register('mod+s', (ev) => {
      if (!this.editing()) return;
      ev.preventDefault();
      void this.save();
    }, { allowInInput: true });
    inject(DestroyRef).onDestroy(off);
    effect(() => {
      const e = this.entry();
      const k = this.kind();
      untracked(() => {
        this.editing.set(false);
        this.text.set(null);
        this.truncated.set(false);
        this.textError.set(null);
        this.versions.set(null);
        if (e && (k === 'text' || k === 'json' || k === 'markdown')) void this.loadText(e);
        if (e && this.drive.location(e.path.split('/')[0])?.capabilities.versions) void this.loadVersions(e);
      });
    });
  }

  startEdit(): void {
    this.draft.set(this.text() ?? '');
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
  }

  async save(): Promise<void> {
    const e = this.entry();
    if (!e || !this.editing() || this.saving()) return;
    this.saving.set(true);
    try {
      const saved = await this.api.writeText(e.path, this.draft(), e.etag);
      this.text.set(this.draft());
      this.editing.set(false);
      this.toast.success('Saved');
      this.saved.emit(saved);
    } catch (err) {
      this.toast.danger((err as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  private async loadVersions(e: Entry): Promise<void> {
    try {
      const vs = await this.api.versions(e.path);
      if (this.entry()?.path === e.path) this.versions.set(vs);
    } catch {
      this.versions.set([]);
    }
  }

  async restore(e: Entry, v: Version): Promise<void> {
    const replace = await this.dialog.confirm({ title: 'Restore this version?', message: `“${e.name}” from ${v.at ? dateTime(v.at) : v.snapshot} will be restored next to the current file as a copy.`, confirmText: 'Restore a copy' });
    if (!replace) return;
    try {
      const r = await this.api.restoreVersion(e.path, v.snapshot, 'rename');
      this.toast.success(`Restored as ${r.path.split('/').pop()}`);
      this.restored.emit(r.path);
    } catch (err) {
      this.toast.danger((err as Error).message);
    }
  }

  private async loadText(e: Entry): Promise<void> {
    try {
      const { text } = await this.api.text(e.path, TEXT_LIMIT);
      if (this.entry()?.path !== e.path) return; // moved on
      this.text.set(text);
      this.truncated.set(e.size > TEXT_LIMIT);
    } catch (err) {
      this.textError.set((err as Error).message);
    }
  }
}
