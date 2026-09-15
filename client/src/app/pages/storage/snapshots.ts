import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkInput } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkEmptyState } from '@mk-kit/ui/status';
import type { Snapshot } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { typedConfirm } from './confirm';
import { ago, bytes, dateTime } from '../../core/format';
import { StorageShell } from './shell';
import { loader, ms } from './load';

/** Every snapshot, newest first, with the space it holds on its own. */
@Component({
  selector: 'app-storage-snapshots',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StorageShell, MkTable, MkTableCell, MkInput, MkEmptyState, MkButton, MkIcon],
  template: `
    <app-storage
      heading="Snapshots"
      description="Newest first. “Used” is what a snapshot alone keeps alive; deleting it frees that much."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="q.run()"
    >
      @if (q.data(); as all) {
        @if (all.length === 0) {
          <mk-empty-state icon="camera" title="No snapshots yet" description="Snapshot policies arrive with the next phase of mk-nas." />
        } @else {
          <div class="toolbar">
            <input mkInput type="search" placeholder="Filter by dataset or name" [value]="filter()" (input)="filter.set($any($event.target).value)" />
            <span class="muted small">{{ rows().length }} of {{ all.length }}</span>
          </div>
          <mk-table [columns]="columns" [data]="rows()" trackKey="name" density="compact" [stackAt]="700">
            <ng-template mkTableCell="name" let-row="row"
              ><span class="mono name">{{ row.dataset }}<span class="muted">@</span>{{ row.snapshot }}</span></ng-template
            >
            <ng-template mkTableCell="creation" let-value
              ><span class="nowrap muted" [title]="f.dateTime(ms(value))">{{ f.ago(ms(value)) }}</span></ng-template
            >
            <ng-template mkTableCell="used" let-value
              ><span class="nowrap">{{ f.bytes(value) }}</span></ng-template
            >
            <ng-template mkTableCell="referenced" let-value
              ><span class="nowrap">{{ f.bytes(value) }}</span></ng-template
            >
            <ng-template mkTableCell="actions" let-row="row">
              <span class="nowrap">
                <button
                  mkButton
                  variant="ghost"
                  size="sm"
                  [disabled]="!isNewest(row)"
                  (click)="rollback(row)"
                  [title]="
                    isNewest(row)
                      ? 'Roll the dataset back to this snapshot'
                      : 'Only the newest snapshot of a dataset can be rolled back to; delete the newer ones first'
                  "
                >
                  <mk-icon name="history" size="sm" />
                </button>
                <button mkButton variant="ghost" size="sm" tone="danger" (click)="destroy(row)" title="Delete this snapshot">
                  <mk-icon name="trash" size="sm" />
                </button>
              </span>
            </ng-template>
          </mk-table>
        }
      }
    </app-storage>
  `,
  styles: [
    `
      .toolbar {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        margin-bottom: var(--mk-space-3);
      }
      .toolbar input {
        max-width: 28rem;
      }
      .name {
        overflow-wrap: anywhere;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class StorageSnapshotsPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly f = { bytes, dateTime, ago };
  protected readonly ms = ms;
  protected readonly filter = signal(inject(ActivatedRoute).snapshot.queryParamMap.get('dataset') ?? '');
  protected readonly q = loader<Snapshot[]>(async () => (await this.api.nas.snapshots()).slice().reverse());
  protected readonly rows = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    const all = this.q.data() ?? [];
    return needle ? all.filter((s) => s.name.toLowerCase().includes(needle)) : all;
  });
  protected readonly columns: MkTableColumn<Snapshot>[] = [
    { key: 'name', header: 'Snapshot', stack: 'title' },
    { key: 'creation', header: 'Taken', width: '170px' },
    { key: 'used', header: 'Used', align: 'end', width: '100px' },
    { key: 'referenced', header: 'Refers to', align: 'end', width: '100px' },
    { key: 'actions', header: '', width: '90px', align: 'end' },
  ];

  /** The newest snapshot of each dataset: ZFS rolls back to that one only (the list is newest first). */
  private readonly newest = computed(() => {
    const seen = new Set<string>();
    const out = new Set<string>();
    for (const s of this.q.data() ?? []) {
      if (seen.has(s.dataset)) continue;
      seen.add(s.dataset);
      out.add(s.name);
    }
    return out;
  });

  constructor() {
    void this.q.run();
  }

  isNewest(s: Snapshot): boolean {
    return this.newest().has(s.name);
  }

  async destroy(s: Snapshot): Promise<void> {
    const confirm = await typedConfirm(this.dialog, {
      title: 'Delete this snapshot?',
      message: `${s.name} goes away and frees ${bytes(s.used)}. The files as they are now stay.`,
      name: s.name,
      confirmText: 'Delete',
    });
    if (confirm === null) return;
    if (confirm === '') return void this.toast.danger('The name did not match; nothing was deleted');
    try {
      await this.api.nas.destroySnapshot(s.name, confirm);
      this.toast.success(`${s.name} deleted`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async rollback(s: Snapshot): Promise<void> {
    const confirm = await typedConfirm(this.dialog, {
      title: `Roll ${s.dataset} back?`,
      message: `Every change to ${s.dataset} since ${s.snapshot} (${ago(ms(s.creation))}) is undone and gone for good — nothing is kept. To bring back single files instead, open them from their versions in the drive.`,
      name: s.name,
      confirmText: 'Roll back',
    });
    if (confirm === null) return;
    if (confirm === '') return void this.toast.danger('The name did not match; nothing was changed');
    try {
      await this.api.nas.rollback(s.name, confirm);
      this.toast.success(`${s.dataset} is back to ${s.snapshot}`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
