import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import { MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import type { MarkedEntry } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { ago, bytes } from '../core/format';
import { iconClass, iconFor } from '../core/file-kind';

interface Row {
  id: string;
  entry: MarkedEntry;
}

/** Recent and Starred share one list: an entry, where it lives, when. */
@Component({
  selector: 'app-marked',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkTable, MkTableCell, MkEmptyState, MkSpinner, MkTooltip],
  template: `
    <div class="page">
      <header class="head">
        <div>
          <h1><mk-icon [name]="kind() === 'starred' ? 'star' : 'clock'" /> {{ kind() === 'starred' ? 'Starred' : 'Recent' }}</h1>
          <p class="muted">{{ kind() === 'starred' ? 'Things you marked to find again quickly.' : 'Files you opened lately, newest first.' }}</p>
        </div>
        @if (kind() === 'recent' && rows().length) {
          <button mkButton variant="ghost" (click)="clear()">Clear</button>
        }
      </header>
      @if (entries() === null) {
        <mk-spinner />
      } @else if (rows().length === 0) {
        <mk-empty-state [icon]="kind() === 'starred' ? 'star' : 'clock'" [title]="kind() === 'starred' ? 'Nothing starred yet' : 'Nothing opened yet'" [description]="kind() === 'starred' ? 'Right-click a file or folder and choose Star.' : 'Files you preview show up here.'" />
      } @else {
        <mk-table [columns]="columns" [data]="rows()" trackKey="id" density="compact" [stackAt]="640" [clickableRows]="true" (rowClick)="open($event)">
          <ng-template mkTableCell="name" let-row="row">
            <span class="name"><mk-icon [name]="icon(row.entry)" size="sm" [class]="iconClass(row.entry)" /> {{ row.entry.name }}</span>
          </ng-template>
          <ng-template mkTableCell="where" let-row="row"><span class="mono muted small">{{ parent(row.entry.path) }}</span></ng-template>
          <ng-template mkTableCell="size" let-row="row"><span class="num muted">{{ row.entry.kind === 'dir' ? '—' : f.bytes(row.entry.size) }}</span></ng-template>
          <ng-template mkTableCell="at" let-row="row"><span class="muted nowrap">{{ f.ago(row.entry.at) }}</span></ng-template>
          <ng-template mkTableCell="actions" let-row="row">
            <button mkButton size="sm" variant="ghost" iconOnly [attr.aria-label]="kind() === 'starred' ? 'Remove star' : 'Star'" [mkTooltip]="drive.isStarred(row.entry.path) ? 'Remove star' : 'Star'" (click)="$event.stopPropagation(); toggleStar(row.entry)"><mk-icon [name]="drive.isStarred(row.entry.path) ? 'star' : 'star-off'" size="sm" [class.starred]="drive.isStarred(row.entry.path)" /></button>
          </ng-template>
        </mk-table>
      }
    </div>
  `,
  styles: [
    `
      .head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--mk-space-4);
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
      .name {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
      }
      .starred {
        color: var(--mk-warning);
      }
      .small {
        font-size: var(--mk-font-size-xs);
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class MarkedPage {
  protected readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(MkToastService);
  readonly kind = input.required<'recent' | 'starred'>();
  protected readonly f = { bytes, ago };
  protected readonly icon = iconFor;
  protected readonly iconClass = iconClass;
  protected readonly entries = signal<MarkedEntry[] | null>(null);
  protected readonly rows = computed<Row[]>(() => (this.entries() ?? []).map((entry) => ({ id: entry.path, entry })));
  protected readonly columns: MkTableColumn<Row>[] = [
    { key: 'name', header: 'Name', stack: 'title' },
    { key: 'where', header: 'In' },
    { key: 'size', header: 'Size', align: 'end', width: '100px' },
    { key: 'at', header: '', width: '120px' },
    { key: 'actions', header: '', width: '56px', align: 'end', stack: 'footer' },
  ];

  constructor() {
    void this.drive.ready().then(() => this.load());
  }

  private async load(): Promise<void> {
    try {
      this.entries.set(this.kind() === 'starred' ? await this.api.stars() : await this.api.recent());
    } catch (e) {
      this.toast.danger(errorMessage(e));
      this.entries.set([]);
    }
  }

  parent(path: string): string {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path;
  }

  open(row: Row): void {
    const target = row.entry.kind === 'dir' ? row.entry.path : this.parent(row.entry.path);
    void this.router.navigate(['/d', ...target.split('/')], row.entry.kind === 'file' ? { queryParams: { open: row.entry.name } } : {});
  }

  async toggleStar(e: MarkedEntry): Promise<void> {
    try {
      const on = await this.drive.toggleStar(e.path);
      if (this.kind() === 'starred' && !on) this.entries.update((l) => l?.filter((x) => x.path !== e.path) ?? null);
    } catch (err) {
      this.toast.danger(errorMessage(err));
    }
  }

  async clear(): Promise<void> {
    await this.api.clearRecent();
    this.entries.set([]);
  }
}
