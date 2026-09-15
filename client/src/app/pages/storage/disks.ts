import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkTag } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkEmptyState } from '@mk-kit/ui/status';
import type { Disk } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { bytes } from '../../core/format';
import { StorageShell } from './shell';
import { loader } from './load';
import { typedConfirm } from './confirm';
import { SmartDialog } from './smart-dialog';

/** Every whole disk the host sees, by its stable id, with what it is used for and what SMART says. */
@Component({
  selector: 'app-storage-disks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StorageShell, MkTable, MkTableCell, MkTag, MkEmptyState, MkButton],
  template: `
    <app-storage
      heading="Disks"
      description="Addressed by /dev/disk/by-id, the name that survives a reboot and a cable swap."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="q.run()"
    >
      @if (q.data(); as disks) {
        @if (disks.length === 0) {
          <mk-empty-state icon="hard-drive" title="No disks" description="The agent sees no whole disks on this host." />
        } @else {
          <mk-table [columns]="columns" [data]="disks" trackKey="id" density="compact" [stackAt]="760">
            <ng-template mkTableCell="id" let-row="row">
              <div class="mono id">{{ row.id }}</div>
              <div class="muted small">{{ row.model ?? '—' }} · {{ row.dev }}</div>
            </ng-template>
            <ng-template mkTableCell="size" let-value
              ><span class="nowrap">{{ f.bytes(value, 0) }}</span></ng-template
            >
            <ng-template mkTableCell="transport" let-row="row">
              <mk-tag size="sm" tone="neutral">{{ (row.transport ?? '?').toUpperCase() }}</mk-tag>
              <mk-tag size="sm" tone="neutral">{{ row.rotational ? 'HDD' : 'SSD' }}</mk-tag>
            </ng-template>
            <ng-template mkTableCell="use" let-row="row">
              @switch (row.use.kind) {
                @case ('pool') {
                  @if (row.use.imported === false) {
                    <mk-tag size="sm" tone="warning" title="A ZFS pool from another system (or a disk replaced out of a pool); no pool on this box uses it"
                      >old pool {{ row.use.pool }}, not imported</mk-tag
                    >
                    <button mkButton variant="ghost" size="sm" tone="danger" (click)="wipe(row)">Wipe</button>
                  } @else {
                    <mk-tag size="sm" tone="primary">pool {{ row.use.pool }}</mk-tag>
                  }
                }
                @case ('os') {
                  <mk-tag size="sm" tone="neutral">operating system</mk-tag>
                }
                @case ('free') {
                  <mk-tag size="sm" tone="success">free</mk-tag>
                }
                @default {
                  <mk-tag size="sm" tone="warning">{{ row.use.what }}</mk-tag>
                  <button mkButton variant="ghost" size="sm" tone="danger" (click)="wipe(row)">Wipe</button>
                }
              }
            </ng-template>
            <ng-template mkTableCell="temp" let-row="row">
              @if (row.asleep) {
                <span
                  class="muted nowrap"
                  [attr.title]="row.smart?.temperature != null ? 'In standby; ' + row.smart.temperature + ' °C when last awake' : 'In standby'"
                  >asleep</span
                >
              } @else if (row.smart?.temperature !== null && row.smart?.temperature !== undefined) {
                <span class="nowrap" [class.warm]="row.smart.temperature >= 45" [class.hot]="row.smart.temperature >= 55">{{ row.smart.temperature }} °C</span>
              } @else {
                <span class="muted">—</span>
              }
            </ng-template>
            <ng-template mkTableCell="age" let-row="row">
              @if (row.smart?.powerOnHours !== null && row.smart?.powerOnHours !== undefined) {
                <span class="nowrap">{{ hours(row.smart.powerOnHours) }}</span>
              } @else {
                <span class="muted">—</span>
              }
            </ng-template>
            <ng-template mkTableCell="smart" let-row="row">
              @if (row.smart; as s) {
                <span class="nowrap">
                  @if (s.passed === false) {
                    <mk-tag size="sm" tone="danger">failed</mk-tag>
                  } @else if (s.passed) {
                    <mk-tag size="sm" tone="success">healthy</mk-tag>
                  } @else {
                    <mk-tag size="sm" tone="neutral">unknown</mk-tag>
                  }
                  @if (s.reallocated) {
                    <mk-tag size="sm" tone="danger">{{ s.reallocated }} reallocated</mk-tag>
                  }
                  @if (s.pending) {
                    <mk-tag size="sm" tone="warning">{{ s.pending }} pending</mk-tag>
                  }
                  @if (s.testing; as t) {
                    <mk-tag size="sm" tone="info">{{ t.kind }} self-test{{ t.percentDone !== null ? ' ' + t.percentDone + '%' : '' }}</mk-tag>
                  }
                  @if (s.wear !== null) {
                    <span class="muted">{{ s.wear }}% worn</span>
                  }
                </span>
                <button mkButton variant="ghost" size="sm" (click)="details(row)">Details</button>
              } @else {
                <span class="muted">no SMART</span>
              }
            </ng-template>
          </mk-table>
        }
      }
    </app-storage>
  `,
  styles: [
    `
      .id {
        overflow-wrap: anywhere;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .warm {
        color: var(--mk-warning);
      }
      .hot {
        color: var(--mk-danger);
      }
    `,
  ],
})
export class StorageDisksPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly f = { bytes };
  protected readonly q = loader<Disk[]>(() => this.api.nas.disks());
  protected readonly columns: MkTableColumn<Disk>[] = [
    { key: 'id', header: 'Disk', stack: 'title' },
    { key: 'size', header: 'Size', align: 'end', width: '90px' },
    { key: 'transport', header: 'Type', width: '120px' },
    { key: 'use', header: 'Used for', width: '170px' },
    { key: 'temp', header: 'Temp', align: 'end', width: '70px' },
    { key: 'age', header: 'Powered on', align: 'end', width: '110px' },
    { key: 'smart', header: 'Health' },
  ];

  constructor() {
    void this.q.run();
  }

  /** A disk that carries an old filesystem, partition table or a pool from another system cannot join a pool; wiping it makes it free. */
  async wipe(d: Disk): Promise<void> {
    const foreign = d.use.kind === 'pool' ? d.use.pool : null;
    const confirm = await typedConfirm(this.dialog, {
      title: `Wipe ${d.model ?? d.id}?`,
      message: foreign
        ? `${d.id} carries the ZFS pool ${foreign} from another system. Wiping clears its labels and partition table: that pool's data on this disk is gone for good. To keep it, import the pool from the Pools page instead.`
        : `Erases the partition table and filesystem signatures on ${d.id}. Whatever is on it is gone.`,
      name: d.id,
      confirmText: 'Wipe',
    });
    if (confirm === null) return;
    if (confirm === '') return void this.toast.danger('The name did not match; nothing was wiped');
    try {
      await this.api.nas.wipeDisk(d.id, confirm);
      this.toast.success(`${d.id} wiped`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  hours(h: number): string {
    return h >= 24 * 365 ? `${(h / (24 * 365)).toFixed(1)} years` : h >= 24 * 30 ? `${Math.round(h / (24 * 30))} months` : `${Math.round(h / 24)} days`;
  }

  details(d: Disk): void {
    this.dialog.open<SmartDialog, void, Disk>(SmartDialog, { data: d, size: 'md' });
  }
}
