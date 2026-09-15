import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkProgressBar, MkTag } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkEmptyState } from '@mk-kit/ui/status';
import { MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import type { ConfigBackup, Dataset, Job, Replication } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { ago, bytes, dateTime } from '../../core/format';
import { StorageShell } from './shell';
import { typedConfirm } from './confirm';
import { loader, ms } from './load';
import { ReplicationDialog, type ReplicationDialogData } from './replication-dialog';

/** Copies of datasets on other machines: what goes where, how it went last time, what is running now, and the key the other side needs. */
@Component({
  selector: 'app-storage-replication',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StorageShell, MkButton, MkTag, MkProgressBar, MkIcon, MkEmptyState, MkSelect],
  template: `
    <app-storage
      heading="Copies elsewhere"
      description="A dataset sent to another machine with ZFS over ssh, snapshot by snapshot. The other side keeps what it received; nothing here ever rolls it back."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="q.run()"
    >
      @if (q.data(); as d) {
        @if (d.replications.length === 0) {
          <mk-empty-state
            icon="copy"
            title="Nothing is copied elsewhere yet"
            description="Add a copy: a dataset here, a machine there. Put this NAS's key on that machine first (below)."
          />
        }
        <ul class="list">
          @for (r of d.replications; track r.id) {
            <li class="repl">
              <div class="repl__head">
                <span class="repl__name mono">{{ r.dataset }}</span>
                <mk-icon name="arrow-right" size="sm" class="muted" />
                <span class="mono">{{ r.user }}@{{ r.host }}{{ r.port !== 22 ? ':' + r.port : '' }}:{{ r.targetDataset }}</span>
                <mk-tag size="sm" tone="neutral">{{ scheduleLabel(r.schedule) }}</mk-tag>
                @if (r.recursive) {
                  <mk-tag size="sm" tone="neutral">with children</mk-tag>
                }
                <span class="spacer"></span>
                <button mkButton variant="ghost" size="sm" [disabled]="!!r.running" (click)="run(r)"><mk-icon name="refresh-cw" size="sm" /> Copy now</button>
                <button mkButton variant="ghost" size="sm" (click)="edit(r)"><mk-icon name="settings" size="sm" /></button>
                <button mkButton variant="ghost" size="sm" tone="danger" (click)="remove(r)"><mk-icon name="trash" size="sm" /></button>
              </div>
              @if (r.running; as j) {
                <div class="running">
                  <mk-progress-bar
                    [value]="j.progress ?? 0"
                    [indeterminate]="j.progress === null"
                    size="sm"
                    tone="info"
                    [label]="j.message ?? 'Copying'"
                    [showValue]="j.progress !== null"
                  />
                  <span class="muted small"
                    >{{ f.bytes(j.bytes) }}{{ j.total ? ' of ' + f.bytes(j.total) : '' }} sent, started {{ f.ago(ms(j.startedAt)) }}</span
                  >
                </div>
              } @else if (r.lastRunAt) {
                <p class="last" [class.bad]="r.lastResult === 'failed'">
                  <mk-icon [name]="r.lastResult === 'ok' ? 'check' : 'circle-alert'" size="sm" />
                  {{ r.lastResult === 'ok' ? 'Last copy' : 'Last copy failed' }} {{ f.ago(ms(r.lastRunAt)) }}{{ r.lastMessage ? ': ' + r.lastMessage : '' }}
                </p>
              } @else {
                <p class="last muted">Never run yet.</p>
              }
              @if (historyFor(r.id); as h) {
                <ul class="history">
                  @for (j of h; track j.id) {
                    <li [class.bad]="j.state === 'failed'">
                      <span class="muted" [title]="f.dateTime(ms(j.startedAt))">{{ f.ago(ms(j.startedAt)) }}</span> {{ j.state === 'failed' ? 'failed' : 'ok'
                      }}{{ j.message ? ' — ' + j.message : '' }}
                    </li>
                  }
                </ul>
              }
            </li>
          }
        </ul>
        <div class="toolbar">
          <button mkButton (click)="add()"><mk-icon name="plus" /> Add a copy</button>
        </div>

        <h2>This NAS's key</h2>
        <p class="muted">
          Put it in the authorized keys of the user on the other machine (on TrueNAS: the user's SSH public key field). The NAS signs in with it and nothing
          else.
        </p>
        <pre class="key">{{ d.key }}</pre>

        @if (d.backup; as b) {
          <h2 class="settings-title">This box's settings</h2>
          <p class="muted">
            Shares, snapshot and scrub schedules, copies, SMB passwords, the drive's accounts, the key above, the box's address: everything that lives on the OS
            disk and not in a pool. Kept in a dataset once a day and snapshotted there, so it goes wherever that dataset is copied. A dead OS disk is then the
            stick, an import of the pool, and Restore.
          </p>
          <div class="settings">
            <mk-select
              class="settings__pick"
              [options]="backupTargets()"
              [value]="b.dataset ?? ''"
              (valueChange)="chooseBackup($event)"
              aria-label="Dataset for the settings"
            />
            <button mkButton size="sm" [disabled]="!b.dataset" [loading]="backing()" (click)="backupNow()">
              <mk-icon name="archive" size="sm" /> Back up now
            </button>
            <button mkButton size="sm" variant="ghost" tone="danger" [disabled]="!b.takenAt" (click)="restore(b)">
              <mk-icon name="archive-restore" size="sm" /> Restore…
            </button>
          </div>
          <p class="muted small">
            @if (!b.dataset) {
              Not kept anywhere yet — pick a dataset.
            } @else if (b.lastAt) {
              Last {{ b.lastResult === 'ok' ? 'kept' : 'failed' }} {{ f.ago(ms(b.lastAt)) }}{{ b.lastMessage ? ' (' + b.lastMessage + ')' : '' }} ·
              {{ b.snapshots }} snapshot{{ b.snapshots === 1 ? '' : 's' }} of it in {{ b.dataset }}.
            } @else {
              Chosen; the first backup runs within the hour, or now with the button.
            }
            @if (b.takenAt && b.files.length) {
              The newest holds {{ b.files.join(', ') }}, taken {{ f.ago(ms(b.takenAt)) }}.
            }
          </p>
        }
      }
    </app-storage>
  `,
  styles: [
    `
      .list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: var(--mk-space-3);
      }
      .repl {
        padding: var(--mk-space-3) var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
      }
      .repl__head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .repl__name {
        font-weight: 600;
      }
      .spacer {
        flex: 1;
      }
      .running {
        display: grid;
        gap: var(--mk-space-1);
        margin-top: var(--mk-space-3);
      }
      .last {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        margin: var(--mk-space-2) 0 0;
        font-size: var(--mk-font-size-sm);
      }
      .last mk-icon {
        color: var(--mk-success);
      }
      .bad,
      .bad mk-icon {
        color: var(--mk-danger);
      }
      .history {
        list-style: none;
        padding: 0;
        margin: var(--mk-space-2) 0 0;
        font-size: var(--mk-font-size-xs);
        display: grid;
        gap: 2px;
      }
      .toolbar {
        margin: var(--mk-space-4) 0 var(--mk-space-6);
      }
      h2 {
        font-size: var(--mk-font-size-lg);
        margin: 0 0 var(--mk-space-2);
      }
      .settings-title {
        margin-top: var(--mk-space-6);
      }
      .settings {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
        margin: var(--mk-space-3) 0 var(--mk-space-2);
      }
      .settings__pick {
        width: 18rem;
        max-width: 100%;
      }
      .small {
        font-size: var(--mk-font-size-xs);
        margin: 0;
      }
      .key {
        font-family: var(--mk-font-mono);
        font-size: var(--mk-font-size-xs);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        padding: var(--mk-space-3);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface);
        user-select: all;
        margin: 0;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class StorageReplicationPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly f = { bytes, ago, dateTime };
  protected readonly ms = ms;
  protected readonly q = loader<{ replications: Replication[]; jobs: Job[]; datasets: Dataset[]; key: string; backup: ConfigBackup | null }>(async () => {
    const [replications, jobs, datasets, key, backup] = await Promise.all([
      this.api.nas.replications(),
      this.api.nas.jobs(),
      this.api.nas.datasets(),
      this.api.nas.replicationKey(),
      // an older agent has no settings backup: the card stays away
      this.api.nas.backup().catch(() => null),
    ]);
    return { replications, jobs, datasets, key: key.publicKey, backup };
  });
  protected readonly backing = signal(false);

  /** Child filesystems only: a pool's root is not a place for it. */
  backupTargets(): MkSelectOption[] {
    const list = (this.q.data()?.datasets ?? []).filter((d) => d.type === 'filesystem' && d.name.includes('/')).map((d) => ({ label: d.name, value: d.name }));
    const chosen = this.q.data()?.backup?.dataset;
    // the chosen dataset may be unmounted or gone right now: still show it as chosen
    if (chosen && !list.some((o) => o.value === chosen)) list.push({ label: chosen, value: chosen });
    return [{ label: 'Not kept anywhere', value: '' }, ...list];
  }

  async chooseBackup(value: unknown): Promise<void> {
    const dataset = typeof value === 'string' && value ? value : null;
    if (dataset === (this.q.data()?.backup?.dataset ?? null)) return;
    try {
      const b = await this.api.nas.setBackup(dataset);
      this.q.data.update((d) => (d ? { ...d, backup: b } : d));
      this.toast.success(dataset ? `Settings will be kept in ${dataset}` : 'Settings are not kept anywhere now');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async backupNow(): Promise<void> {
    this.backing.set(true);
    try {
      const b = await this.api.nas.runBackup();
      this.q.data.update((d) => (d ? { ...d, backup: b } : d));
      this.toast.success(`Settings kept in ${b.dataset}`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.backing.set(false);
    }
  }

  async restore(b: ConfigBackup): Promise<void> {
    if (!b.dataset) return;
    const confirm = await typedConfirm(this.dialog, {
      title: "Restore this box's settings?",
      message: `Everything set on this box — shares, schedules, copies, SMB passwords, the drive's accounts — is replaced by the backup in ${b.dataset} from ${dateTime(ms(b.takenAt))}. The agent and the drive restart; this page will need a reload.`,
      name: b.dataset,
      confirmText: 'Restore',
    });
    if (confirm === null) return;
    if (confirm === '') return void this.toast.danger('The name did not match; nothing was restored');
    try {
      const r = await this.api.nas.restoreBackup(b.dataset, confirm);
      this.toast.info(`Restoring ${r.files.length} files; the drive restarts in a moment — reload in a few seconds`, { duration: 0 });
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
  protected readonly polling = signal(false);

  constructor() {
    void this.q.run();
    const timer = setInterval(() => {
      if (this.q.data()?.replications.some((r) => r.running)) void this.q.run();
    }, 5_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  scheduleLabel(s: Replication['schedule']): string {
    return { hourly: 'every hour', daily: 'every day', weekly: 'every week', manual: 'by hand' }[s];
  }

  /** The finished runs of one copy, newest first, a handful. */
  historyFor(id: number): Job[] | null {
    const h = (this.q.data()?.jobs ?? []).filter((j) => j.replicationId === id && j.state !== 'running').slice(0, 5);
    return h.length ? h : null;
  }

  async add(): Promise<void> {
    await this.open(null);
  }

  async edit(r: Replication): Promise<void> {
    await this.open(r);
  }

  private async open(r: Replication | null): Promise<void> {
    const datasets = (this.q.data()?.datasets ?? []).filter((d) => d.type === 'filesystem').map((d) => d.name);
    const ref = this.dialog.open<ReplicationDialog, Replication | undefined, ReplicationDialogData>(ReplicationDialog, {
      data: { replication: r, datasets },
      size: 'md',
    });
    const result = await ref.afterClosed;
    if (!result) return;
    this.toast.success(r ? 'Copy updated' : `${result.dataset} will be copied to ${result.host}`);
    await this.q.run();
  }

  async run(r: Replication): Promise<void> {
    try {
      await this.api.nas.runReplication(r.id);
      this.toast.success(`Copying ${r.dataset} to ${r.host}`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async remove(r: Replication): Promise<void> {
    if (
      !(await this.dialog.confirm({
        title: `Stop copying ${r.dataset} to ${r.host}?`,
        message: 'The copy on the other machine stays as it is; only the job here is removed.',
        confirmText: 'Stop copying',
        tone: 'danger',
      }))
    )
      return;
    try {
      await this.api.nas.removeReplication(r.id);
      this.toast.success('Copy removed');
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
