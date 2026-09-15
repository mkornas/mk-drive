import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkTag } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkNumberInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkEmptyState } from '@mk-kit/ui/status';
import type { Compression, Dataset, Policy, Share, Snapshot } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { bytes, lanName } from '../../core/format';
import { StorageShell } from './shell';
import { loader } from './load';
import { GIB, typedConfirm } from './confirm';
import { COMPRESSIONS, DatasetDialog } from './dataset-dialog';
import { PolicyDialog, type PolicyDialogData } from './policy-dialog';
import { ShareDialog, type ShareDialogData } from './share-dialog';

/** Every filesystem and volume, with what it uses, what it may still use, and how it is set; make one, snapshot one, give one a policy. */
@Component({
  selector: 'app-storage-datasets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StorageShell, MkTable, MkTableCell, MkTag, MkEmptyState, MkButton, MkIcon, MkFormField, MkInput, MkNumberInput, MkSelect, MkCheckbox],
  template: `
    <app-storage
      heading="Datasets"
      description="Filesystems and volumes across every pool. A dataset made as a location shows up in the drive's sidebar right away."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="q.run()"
    >
      @if (q.data(); as data) {
        @if (data.datasets.length === 0 && !creating()) {
          <mk-empty-state icon="layers" title="No datasets" description="Make a pool first; it is a dataset too." />
        } @else if (data.datasets.length) {
          <mk-table [columns]="columns" [data]="data.datasets" trackKey="name" density="compact" [stackAt]="820">
            <ng-template mkTableCell="name" let-row="row">
              <span class="mono name" [style.padding-left.rem]="depth(row.name) * 1">{{ row.name }}</span>
              @if (row.type === 'volume') {
                <mk-tag size="sm" tone="neutral">volume</mk-tag>
              }
              @if (!row.mounted && row.type === 'filesystem') {
                <mk-tag size="sm" tone="warning">not mounted</mk-tag>
              }
              @if (shareOf(row.name); as sh) {
                <mk-tag size="sm" tone="neutral">{{ sh.smb && sh.nfs ? 'SMB + NFS' : sh.smb ? 'SMB' : 'NFS' }}</mk-tag>
              }
              @if (policyOf(row.name); as p) {
                <mk-tag size="sm" tone="primary">{{ describe(p) }}</mk-tag>
              }
            </ng-template>
            <ng-template mkTableCell="used" let-row="row">
              <span class="nowrap">{{ f.bytes(row.used) }}</span>
              @if (row.quota) {
                <span class="quota" [class.quota--warn]="row.used / row.quota >= 0.8" [class.quota--bad]="row.used / row.quota >= 0.95"
                  ><span [style.width.%]="Math.min(100, (row.used / row.quota) * 100)"></span
                ></span>
              }
            </ng-template>
            <ng-template mkTableCell="available" let-value
              ><span class="nowrap">{{ f.bytes(value) }}</span></ng-template
            >
            <ng-template mkTableCell="quota" let-value
              ><span class="nowrap">{{ value === null ? '—' : f.bytes(value, 0) }}</span></ng-template
            >
            <ng-template mkTableCell="compression" let-row="row"
              ><span class="nowrap">{{ row.compression }} · {{ row.compressratio.toFixed(2) }}×</span></ng-template
            >
            <ng-template mkTableCell="mountpoint" let-row="row">
              @if (locationOf(row); as loc) {
                <a class="loc" [routerLink]="'/d/' + encode(loc)"><mk-icon name="folder-open" size="sm" /> {{ loc }}</a>
              } @else {
                <span class="mono small">{{ row.mountpoint ?? '—' }}</span>
              }
            </ng-template>
            <ng-template mkTableCell="snapshots" let-row="row">
              @if (snapshotCount(row.name); as n) {
                <a class="plain nowrap" [routerLink]="'/storage/snapshots'" [queryParams]="{ dataset: row.name }">{{ n }}</a>
              } @else {
                <span class="muted">0</span>
              }
            </ng-template>
            <ng-template mkTableCell="actions" let-row="row">
              <span class="nowrap">
                <button mkButton variant="ghost" size="sm" (click)="share(row)" [title]="shareOf(row.name) ? 'Shared — change' : 'Share over the network'">
                  <mk-icon [name]="shareOf(row.name) ? 'globe' : 'link'" size="sm" />
                </button>
                <button mkButton variant="ghost" size="sm" (click)="snapshot(row)" title="Take a snapshot now"><mk-icon name="camera" size="sm" /></button>
                <button mkButton variant="ghost" size="sm" (click)="policy(row)" title="Automatic snapshots"><mk-icon name="clock" size="sm" /></button>
                <button mkButton variant="ghost" size="sm" (click)="edit(row)" title="Quota, compression, atime"><mk-icon name="settings" size="sm" /></button>
                @if (depth(row.name) > 0) {
                  <button mkButton variant="ghost" size="sm" tone="danger" (click)="destroy(row)" title="Destroy this dataset">
                    <mk-icon name="trash" size="sm" />
                  </button>
                }
              </span>
            </ng-template>
          </mk-table>
        }

        @if (creating()) {
          <form class="form" (submit)="create($event)">
            <h2>New dataset</h2>
            <div class="row">
              <mk-form-field label="In"><mk-select [options]="parents()" [(value)]="parent" /></mk-form-field>
              <mk-form-field label="Name"
                ><input mkInput [value]="name()" (input)="name.set($any($event.target).value)" placeholder="photos" required autocomplete="off"
              /></mk-form-field>
            </div>
            <div class="row">
              <mk-form-field label="Quota (GiB)" hint="Empty = no limit"><mk-number-input [(value)]="quota" [min]="1" [step]="1" /></mk-form-field>
              <mk-form-field label="Compression"><mk-select [options]="compressions" [(value)]="compression" /></mk-form-field>
            </div>
            <mk-checkbox [(checked)]="atime">Record access times (atime)</mk-checkbox>
            <mk-checkbox [(checked)]="location"
              >Offer it as a location of this drive — mounted under the drive's locations, owned by its user, in the sidebar at once</mk-checkbox
            >
            <div class="actions">
              <button mkButton type="submit" [loading]="busy()" [disabled]="!valid()"><mk-icon name="plus" size="sm" /> Create {{ fullName() }}</button>
              <button mkButton variant="ghost" type="button" (click)="creating.set(false)">Cancel</button>
            </div>
          </form>
        } @else if (data.datasets.length) {
          <div class="toolbar">
            <button mkButton (click)="creating.set(true)"><mk-icon name="plus" /> New dataset</button>
          </div>
        }
      }
    </app-storage>
  `,
  styles: [
    `
      .name {
        overflow-wrap: anywhere;
      }
      .quota {
        display: block;
        height: 4px;
        width: 72px;
        margin-top: 4px;
        border-radius: 2px;
        background: var(--mk-border-subtle);
        overflow: hidden;
      }
      .quota span {
        display: block;
        height: 100%;
        background: var(--mk-primary);
      }
      .quota--warn span {
        background: var(--mk-warning);
      }
      .quota--bad span {
        background: var(--mk-danger);
      }
      .loc {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-1);
        color: var(--mk-primary);
        text-decoration: none;
      }
      .loc:hover,
      .plain:hover {
        text-decoration: underline;
      }
      .plain {
        color: inherit;
        text-decoration: none;
      }
      .small {
        font-size: var(--mk-font-size-xs);
        white-space: nowrap;
      }
      h2 {
        margin: 0;
        font-size: var(--mk-font-size-lg);
      }
      .form {
        display: grid;
        gap: var(--mk-space-3);
        padding: var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        margin-top: var(--mk-space-4);
      }
      .row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--mk-space-3);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .toolbar {
        margin-top: var(--mk-space-4);
      }
    `,
  ],
})
export class StorageDatasetsPage {
  private readonly api = inject(ApiService);
  private readonly drive = inject(DriveService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly f = { bytes };
  protected readonly compressions = COMPRESSIONS;
  protected readonly Math = Math;
  protected readonly encode = encodeURIComponent;
  protected readonly q = loader<{ datasets: Dataset[]; policies: Policy[]; snapshots: Snapshot[]; shares: Share[]; host: string }>(async () => {
    const [datasets, policies, snapshots, shares, version] = await Promise.all([
      this.api.nas.datasets(),
      this.api.nas.policies(),
      this.api.nas.snapshots().catch(() => [] as Snapshot[]),
      this.api.nas.shares().catch(() => [] as Share[]),
      this.api.nas.version(),
    ]);
    return { datasets, policies, snapshots, shares, host: version.hostname };
  });
  protected readonly parents = computed<MkSelectOption[]>(() =>
    (this.q.data()?.datasets ?? []).filter((d) => d.type === 'filesystem').map((d) => ({ label: d.name, value: d.name })),
  );
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly parent = signal('');
  protected readonly name = signal('');
  protected readonly quota = signal<number | null>(null);
  protected readonly compression = signal<Compression>('lz4');
  protected readonly atime = signal(false);
  protected readonly location = signal(true);
  protected readonly fullName = computed(() => `${this.parent() || (this.parents()[0]?.value as string) || '?'}/${this.name() || '…'}`);
  protected readonly valid = computed(() => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(this.name()) && !!(this.parent() || this.parents()[0]));
  protected readonly columns: MkTableColumn<Dataset>[] = [
    { key: 'name', header: 'Dataset', stack: 'title' },
    { key: 'used', header: 'Used', align: 'end', width: '100px' },
    { key: 'available', header: 'Available', align: 'end', width: '100px' },
    { key: 'quota', header: 'Quota', align: 'end', width: '90px' },
    { key: 'compression', header: 'Compression', width: '140px' },
    { key: 'snapshots', header: 'Snapshots', align: 'end', width: '90px' },
    { key: 'mountpoint', header: 'Mounted at' },
    { key: 'actions', header: '', width: '232px', align: 'end' },
  ];

  constructor() {
    void this.q.run();
  }

  depth(name: string): number {
    return name.split('/').length - 1;
  }

  shareOf(dataset: string): Share | undefined {
    return this.q.data()?.shares.find((s) => s.dataset === dataset);
  }

  async share(d: Dataset): Promise<void> {
    const ref = this.dialog.open<ShareDialog, Share | null | undefined, ShareDialogData>(ShareDialog, {
      data: { dataset: d.name, share: this.shareOf(d.name) ?? null, host: lanName(this.q.data()?.host ?? 'nas') },
      size: 'md',
    });
    const result = await ref.afterClosed;
    if (result === undefined) return;
    this.toast.success(result ? `${d.name} is shared` : `${d.name} is no longer shared`);
    await this.q.run();
  }

  snapshotCount(dataset: string): number {
    return (this.q.data()?.snapshots ?? []).filter((s) => s.dataset === dataset).length;
  }

  /** The drive location this dataset is, when it is mounted where the container sees it. */
  locationOf(d: Dataset): string | null {
    if (!d.mountpoint) return null;
    const name = d.mountpoint.split('/').pop() ?? '';
    return this.drive.locations().some((l) => l.name === name && l.source === 'mount') ? name : null;
  }

  policyOf(dataset: string): Policy | undefined {
    return this.q.data()?.policies.find((p) => p.dataset === dataset);
  }

  describe(p: Policy): string {
    const parts = [p.hourly && `${p.hourly}h`, p.daily && `${p.daily}d`, p.weekly && `${p.weekly}w`, p.monthly && `${p.monthly}m`].filter(Boolean);
    return `snapshots ${parts.join(' ')}`;
  }

  async create(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.valid()) return;
    this.busy.set(true);
    try {
      const parent = this.parent() || (this.parents()[0].value as string);
      const q = this.quota();
      const ds = await this.api.nas.createDataset({
        name: `${parent}/${this.name()}`,
        quota: q ? q * GIB : null,
        compression: this.compression(),
        atime: this.atime(),
        location: this.location(),
      });
      this.toast.success(`${ds.name} created${this.location() ? ' and offered as a location' : ''}`);
      this.creating.set(false);
      this.name.set('');
      this.quota.set(null);
      if (this.location()) await this.drive.refreshLocations();
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async snapshot(d: Dataset): Promise<void> {
    try {
      const s = await this.api.nas.createSnapshot(d.name);
      this.toast.success(`Snapshot ${s.snapshot} of ${d.name} taken`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async edit(d: Dataset): Promise<void> {
    const ref = this.dialog.open<DatasetDialog, Dataset | undefined, Dataset>(DatasetDialog, { data: d, size: 'sm' });
    const changed = await ref.afterClosed;
    if (changed) {
      this.toast.success(`${d.name} updated`);
      await this.q.run();
    }
  }

  /** Children, a share and a replication are refused by the agent; the snapshot count is said up front so typing the name means them too. */
  async destroy(d: Dataset): Promise<void> {
    const snapshots = this.snapshotCount(d.name);
    const loc = this.locationOf(d);
    const parts = [
      `${d.name} and the ${bytes(d.used)} in it are gone for good.`,
      snapshots ? `Its ${snapshots} snapshot${snapshots > 1 ? 's' : ''} go with it.` : '',
      loc ? `The location ${loc} leaves this drive.` : '',
    ].filter(Boolean);
    const confirm = await typedConfirm(this.dialog, { title: 'Destroy this dataset?', message: parts.join(' '), name: d.name, confirmText: 'Destroy' });
    if (confirm === null) return;
    if (confirm === '') return void this.toast.danger('The name did not match; nothing was destroyed');
    try {
      const r = await this.api.nas.destroyDataset({ dataset: d.name, confirm, ...(snapshots ? { snapshots: true } : {}) });
      this.toast.success(`${r.destroyed} destroyed${r.snapshots ? ` with ${r.snapshots} snapshot${r.snapshots > 1 ? 's' : ''}` : ''}`);
      if (r.location) await this.drive.refreshLocations();
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async policy(d: Dataset): Promise<void> {
    const ref = this.dialog.open<PolicyDialog, Policy | null | undefined, PolicyDialogData>(PolicyDialog, {
      data: { dataset: d.name, policy: this.policyOf(d.name) ?? null },
      size: 'md',
    });
    const result = await ref.afterClosed;
    if (result !== undefined) {
      this.toast.success(result ? `Automatic snapshots of ${d.name} set` : `Automatic snapshots of ${d.name} switched off`);
      await this.q.run();
    }
  }
}
