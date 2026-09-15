import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkDialogService, MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import type { TrashEntry } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { OpsService } from '../core/ops.service';
import { ago, bytes } from '../core/format';

interface Row {
  id: string;
  entry: TrashEntry;
}

@Component({
  selector: 'app-trash',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkTable, MkTableCell, MkEmptyState, MkSpinner, MkTooltip],
  template: `
    <div class="page">
      <header class="head">
        <div>
          <h1><mk-icon name="trash" /> Trash · {{ location() }}</h1>
          <p class="muted">Deleted items stay here for 30 days, then they are gone for good.</p>
        </div>
        <div class="row">
          <button mkButton variant="ghost" (click)="back()"><mk-icon name="arrow-left" /> Back to {{ location() }}</button>
          @if (rows().length) {
            <button mkButton variant="outline" tone="danger" (click)="empty()">Empty trash</button>
          }
        </div>
      </header>
      @if (entries() === null) {
        <mk-spinner />
      } @else if (rows().length === 0) {
        <mk-empty-state icon="trash" title="The trash is empty" />
      } @else {
        <mk-table [columns]="columns" [data]="rows()" trackKey="id" density="compact" [stackAt]="640">
          <ng-template mkTableCell="name" let-row="row">
            <span class="name"><mk-icon [name]="row.entry.kind === 'dir' ? 'folder' : 'file'" size="sm" class="muted" /> {{ row.entry.name }}</span>
          </ng-template>
          <ng-template mkTableCell="original" let-row="row"><span class="mono muted small">{{ row.entry.original }}</span></ng-template>
          <ng-template mkTableCell="size" let-row="row"><span class="num muted">{{ row.entry.kind === 'dir' ? '—' : f.bytes(row.entry.size) }}</span></ng-template>
          <ng-template mkTableCell="deletedAt" let-row="row"><span class="muted nowrap">{{ f.ago(row.entry.deletedAt) }} by {{ row.entry.deletedBy }}</span></ng-template>
          <ng-template mkTableCell="actions" let-row="row">
            <span class="row">
              <button mkButton size="sm" variant="ghost" (click)="restore(row.entry)"><mk-icon name="undo" size="sm" /> Restore</button>
              <button mkButton size="sm" variant="ghost" tone="danger" iconOnly aria-label="Delete forever" mkTooltip="Delete forever" (click)="purge(row.entry)"><mk-icon name="trash" size="sm" /></button>
            </span>
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
        flex-wrap: wrap;
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
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class TrashPage {
  private readonly api = inject(ApiService);
  private readonly ops = inject(OpsService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly f = { bytes, ago };
  protected readonly location = toSignal(this.route.paramMap.pipe(map((p) => p.get('location') ?? '')), { initialValue: '' });
  protected readonly entries = signal<TrashEntry[] | null>(null);
  protected readonly rows = computed<Row[]>(() => (this.entries() ?? []).map((entry) => ({ id: entry.id, entry })));
  protected readonly columns: MkTableColumn<Row>[] = [
    { key: 'name', header: 'Name', stack: 'title' },
    { key: 'original', header: 'Was in' },
    { key: 'size', header: 'Size', align: 'end', width: '100px' },
    { key: 'deletedAt', header: 'Deleted', width: '220px' },
    { key: 'actions', header: '', width: '160px', align: 'end', stack: 'footer' },
  ];

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.entries.set(await this.api.trash(this.location()));
    } catch (e) {
      this.toast.danger(errorMessage(e));
      this.entries.set([]);
    }
  }

  back(): void {
    void this.router.navigateByUrl('/d/' + encodeURIComponent(this.location()));
  }

  async restore(e: TrashEntry): Promise<void> {
    try {
      const r = await this.api.restore(e.id, 'fail').catch(async (err) => {
        if (err?.status !== 409) throw err;
        const choice = await this.ops.askConflict([e.name], 'restore');
        if (!choice || choice.policy === 'skip') return null;
        return this.api.restore(e.id, choice.policy);
      });
      if (!r) return;
      this.entries.update((l) => l?.filter((x) => x.id !== e.id) ?? null);
      this.toast.success(`Restored to ${r.path}`);
    } catch (err) {
      this.toast.danger(errorMessage(err));
    }
  }

  async purge(e: TrashEntry): Promise<void> {
    if (!(await this.dialog.confirm({ title: `Delete “${e.name}” forever?`, message: 'This cannot be undone.', confirmText: 'Delete forever', tone: 'danger' }))) return;
    try {
      await this.api.purge(e.id);
      this.entries.update((l) => l?.filter((x) => x.id !== e.id) ?? null);
    } catch (err) {
      this.toast.danger(errorMessage(err));
    }
  }

  async empty(): Promise<void> {
    const n = this.rows().length;
    if (!(await this.dialog.confirm({ title: 'Empty the trash?', message: `${n} item${n === 1 ? '' : 's'} will be deleted forever.`, confirmText: 'Empty trash', tone: 'danger' }))) return;
    try {
      await this.api.emptyTrash(this.location());
      this.entries.set([]);
      this.toast.success('Trash emptied');
    } catch (err) {
      this.toast.danger(errorMessage(err));
    }
  }
}
