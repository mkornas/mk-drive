import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkDescItem, MkDescriptionList } from '@mk-kit/ui/data';
import { MkSpinner } from '@mk-kit/ui/status';
import type { Entry, FolderStats } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { ago, bytes, dateTime } from '../core/format';
import { iconClass, iconFor } from '../core/file-kind';

export interface FolderDetailsData {
  entry: Entry;
  showHidden: boolean;
}

/** What is under a folder: size, counts, the newest change and the largest files, counted while you watch. */
@Component({
  selector: 'app-folder-details-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkIcon, MkDescriptionList, MkDescItem, MkSpinner],
  template: `
    <mk-dialog [dialogTitle]="data.entry.name">
      <p class="mono muted path">{{ data.entry.path }}</p>
      @if (stats(); as s) {
        <mk-description-list layout="grid">
          <mk-desc-item term="Size">{{ f.bytes(s.bytes) }}{{ s.truncated ? ' and counting' : '' }}</mk-desc-item>
          <mk-desc-item term="Files">{{ s.files }}{{ s.truncated ? '+' : '' }}</mk-desc-item>
          <mk-desc-item term="Folders">{{ s.dirs }}{{ s.truncated ? '+' : '' }}</mk-desc-item>
          <mk-desc-item term="Last change">{{ s.newest ? f.dateTime(s.newest) + ' (' + f.ago(s.newest) + ')' : '—' }}</mk-desc-item>
        </mk-description-list>
        @if (s.truncated) {
          <p class="muted small">This folder is too big to count in one go, so these are floors.</p>
        }
        @if (s.largest.length) {
          <h3>Largest files</h3>
          <ul class="list">
            @for (e of s.largest; track e.path) {
              <li><button type="button" class="item" (click)="open(e)"><mk-icon [name]="icon(e)" size="sm" [class]="iconClass(e)" /><span class="item__name">{{ e.name }}</span><span class="muted small item__where">{{ parent(e.path) }}</span><span class="num muted">{{ f.bytes(e.size) }}</span></button></li>
            }
          </ul>
        }
      } @else if (error(); as err) {
        <p class="muted">{{ err }}</p>
      } @else {
        <div class="wait"><mk-spinner size="sm" /> <span class="muted">Counting…</span></div>
      }
      <div mkDialogFooter class="footer"><button mkButton variant="ghost" (click)="ref.close()">Done</button></div>
    </mk-dialog>
  `,
  styles: [
    `
      :host {
        display: block;
        width: min(480px, calc(100vw - 48px));
      }
      .path {
        margin: 0 0 var(--mk-space-3);
        font-size: var(--mk-font-size-xs);
        overflow-wrap: anywhere;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .wait {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        padding: var(--mk-space-4) 0;
      }
      h3 {
        font-size: var(--mk-font-size-sm);
        font-weight: 600;
        margin: var(--mk-space-4) 0 var(--mk-space-1);
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
      .item__name {
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item__where {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .num {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .footer {
        display: flex;
        justify-content: flex-end;
      }
    `,
  ],
})
export class FolderDetailsDialog {
  protected readonly data = inject<FolderDetailsData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<void>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly f = { ago, bytes, dateTime };
  protected readonly icon = iconFor;
  protected readonly iconClass = iconClass;
  protected readonly stats = signal<FolderStats | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.api
      .folderStats(this.data.entry.path, this.data.showHidden)
      .then((s) => this.stats.set(s))
      .catch((e) => this.error.set(errorMessage(e)));
  }

  parent(path: string): string {
    const rel = path.startsWith(this.data.entry.path + '/') ? path.slice(this.data.entry.path.length + 1) : path;
    return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  }

  open(e: Entry): void {
    this.ref.close();
    const dir = e.path.slice(0, e.path.lastIndexOf('/'));
    void this.router.navigate(['/d', ...dir.split('/')], { queryParams: { open: e.name } });
  }
}
