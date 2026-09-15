import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkCard, MkProgressBar, MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkEmptyState } from '@mk-kit/ui/status';
import type { Disk, ImportablePool, Job, Pool, PoolLayout, ScrubInterval, ScrubPolicy, Vdev } from '../../../../../shared/nas';
import { ReplaceDialog, type ReplaceDialogData } from './replace-dialog';
import { ApiService, errorMessage } from '../../core/api.service';
import { ago, bytes, dateTime } from '../../core/format';
import { StorageShell } from './shell';
import { loader, ms } from './load';

const LAYOUTS: MkSelectOption[] = [
  { label: 'Mirror — two or more disks, each a full copy (the default)', value: 'mirror' },
  { label: 'raidz1 — three or more disks, one may fail', value: 'raidz1' },
  { label: 'raidz2 — four or more disks, two may fail', value: 'raidz2' },
  { label: 'Single disk — no safety, for scratch', value: 'single' },
];
const MIN: Record<PoolLayout, number> = { single: 1, mirror: 2, raidz1: 3, raidz2: 4 };
const SCRUB_INTERVALS: MkSelectOption[] = [
  { label: 'Scrub monthly', value: 'monthly' },
  { label: 'Scrub weekly', value: 'weekly' },
  { label: 'No automatic scrub', value: 'off' },
];

/** One card per pool: state, space, the vdev tree as zpool status shows it, the scan running now and the ones before it. And the form that makes one. */
@Component({
  selector: 'app-storage-pools',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    StorageShell,
    MkCard,
    MkTag,
    MkProgressBar,
    MkEmptyState,
    MkButton,
    MkIcon,
    MkFormField,
    MkInput,
    MkSelect,
    MkCheckbox,
    MkAlert,
  ],
  template: `
    <app-storage
      heading="Pools"
      description="What zpool status says, without the terminal."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="reload()"
    >
      @if (q.data(); as data) {
        @if (data.pools.length === 0 && !creating()) {
          <mk-empty-state
            icon="database"
            title="No pool yet"
            description="Pick the disks and make one. The disks are formatted; nothing else on the box is touched."
          >
            <div mkEmptyStateActions class="empty-actions">
              <a mkButton routerLink="/storage/setup"><mk-icon name="database" size="sm" /> Set up this NAS</a>
              <button mkButton variant="outline" type="button" (click)="creating.set(true)">Just the pool</button>
            </div>
          </mk-empty-state>
        }
        @for (p of data.pools; track p.name) {
          <mk-card class="pool">
            <div class="pool__head">
              <h2>{{ p.name }}</h2>
              <mk-tag [tone]="p.health === 'ONLINE' ? 'success' : p.health === 'DEGRADED' ? 'warning' : 'danger'">{{ p.health }}</mk-tag>
              <span class="muted">{{ f.bytes(p.allocated, 0) }} of {{ f.bytes(p.size, 0) }} used · {{ f.bytes(p.free, 0) }} free</span>
              <span class="spacer"></span>
              <mk-select
                class="interval"
                size="sm"
                aria-label="Automatic scrub"
                [options]="scrubIntervals"
                [value]="intervalOf(p.name)"
                (valueChange)="setInterval(p, $event)"
              />
              <button mkButton variant="ghost" size="sm" [disabled]="p.scrub?.state === 'running'" (click)="scrub(p)">
                <mk-icon name="shield-check" size="sm" /> Scrub now
              </button>
            </div>
            <mk-progress-bar
              [value]="p.capacity"
              size="sm"
              [tone]="p.capacity >= 90 ? 'danger' : p.capacity >= 80 ? 'warning' : 'primary'"
              [label]="p.capacity + '% used'"
            />
            @if (runningScan(p.name); as job) {
              <div class="scrubbing">
                <mk-progress-bar
                  [value]="job.progress ?? 0"
                  [indeterminate]="job.progress === null"
                  size="sm"
                  tone="info"
                  [label]="(job.kind === 'resilver' ? 'Rebuilding onto the new disk' : 'Scrub in progress') + ', started ' + f.ago(ms(job.startedAt))"
                  showValue
                />
              </div>
            } @else if (p.scrub?.state === 'running') {
              <div class="scrubbing">
                <mk-progress-bar
                  [value]="p.scrub?.percent ?? 0"
                  [indeterminate]="p.scrub?.percent === null"
                  size="sm"
                  tone="info"
                  [label]="p.scrub?.kind === 'resilver' ? 'Rebuilding onto the new disk' : 'Scrub in progress'"
                  showValue
                />
              </div>
            }
            @if (p.health !== 'ONLINE') {
              <mk-alert
                [tone]="p.health === 'DEGRADED' ? 'warning' : 'danger'"
                [title]="
                  p.health === 'DEGRADED' ? 'The pool is degraded — it works, but with less safety than it should' : 'The pool is ' + p.health.toLowerCase()
                "
                class="alert"
              >
                @if (p.status) {
                  <p class="note">{{ p.status }}</p>
                }
                @if (p.action) {
                  <p class="note"><strong>What to do.</strong> {{ p.action }} Use Replace next to the failed disk below.</p>
                }
              </mk-alert>
            } @else {
              @if (p.status) {
                <p class="note"><strong>Status.</strong> {{ p.status }}</p>
              }
              @if (p.action) {
                <p class="note"><strong>Action.</strong> {{ p.action }}</p>
              }
            }
            <ul class="tree">
              @for (v of p.vdevs; track v.name) {
                <ng-container *ngTemplateOutlet="node; context: { $implicit: v, depth: 0, pool: p }" />
              }
            </ul>
            <p class="muted small">
              @if (p.scrub; as s) {
                @if (s.state === 'running') {
                  {{ s.kind === 'resilver' ? 'Rebuild' : 'Scrub' }} running{{ s.percent !== null ? ', ' + s.percent + '% done' : '' }}.
                } @else if (s.state === 'finished') {
                  {{ s.kind === 'resilver' ? 'Last rebuild' : 'Last scrub' }} {{ s.finishedAt ? f.dateTime(ms(s.finishedAt)) : ''
                  }}{{ s.errors ? ', ' + s.errors + ' errors' : ', no errors' }}.
                } @else {
                  Never scrubbed.
                }
              } @else {
                Never scrubbed.
              }
              @if (p.errors) {
                {{ p.errors }}.
              }
              @if (p.fragmentation !== null) {
                Fragmentation {{ p.fragmentation }}%.
              }
            </p>
            @if (historyOf(p.name); as history) {
              @if (history.length) {
                <ul class="history">
                  @for (j of history; track j.id) {
                    <li class="history__row">
                      <mk-tag size="sm" [tone]="j.state === 'done' ? 'success' : 'danger'">{{ j.kind }}</mk-tag>
                      <span class="muted small" [title]="f.dateTime(ms(j.startedAt))">{{ f.ago(ms(j.startedAt)) }}</span>
                      <span class="small" [title]="j.message ?? ''">{{ scanSummary(j) }}</span>
                    </li>
                  }
                </ul>
              }
            }
          </mk-card>
        }

        @if (data.importable.length) {
          <mk-card class="pool">
            <h2>Pools from elsewhere</h2>
            <p class="muted">
              Disks in this box carry a pool that is not imported: from another machine, an earlier install, or a backup drive. Importing mounts it here; the
              disks are not changed.
            </p>
            <ul class="import">
              @for (ip of data.importable; track ip.id) {
                <li class="import__row">
                  <span class="mono">{{ ip.name }}</span>
                  <mk-tag size="sm" [tone]="ip.state === 'ONLINE' ? 'success' : 'warning'">{{ ip.state }}</mk-tag>
                  <span class="muted small">{{ ip.devices.join(', ') }}</span>
                  <span class="spacer"></span>
                  <button
                    mkButton
                    size="sm"
                    [loading]="importing() === ip.name"
                    [disabled]="ip.state !== 'ONLINE' && ip.state !== 'DEGRADED'"
                    (click)="importPool(ip.name)"
                  >
                    Import
                  </button>
                </li>
                @if (ip.status) {
                  <li class="muted small import__note">{{ ip.status }}</li>
                }
              }
            </ul>
          </mk-card>
        }

        @if (creating()) {
          <mk-card class="pool">
            <h2>New pool</h2>
            <form class="form" (submit)="create($event)">
              <div class="row">
                <mk-form-field label="Name" hint="Letters, digits, - _ . : — this is also where it mounts (/name)"
                  ><input mkInput [value]="name()" (input)="name.set($any($event.target).value)" placeholder="tank" required autocomplete="off"
                /></mk-form-field>
                <mk-form-field label="Layout"><mk-select [options]="layouts" [(value)]="layout" /></mk-form-field>
              </div>
              <fieldset class="disks">
                <legend>Disks — free ones only; a disk that carries something is wiped on the Disks page first</legend>
                @if (free().length === 0) {
                  <p class="muted">No free disk.</p>
                }
                @for (d of free(); track d.id) {
                  <mk-checkbox [checked]="picked().has(d.id)" (checkedChange)="toggle(d.id, $event)">
                    <span class="mono">{{ d.id }}</span>
                    <span class="muted">· {{ d.model ?? '?' }} · {{ f.bytes(d.size, 0) }} · {{ d.rotational ? 'HDD' : 'SSD' }}</span>
                  </mk-checkbox>
                }
              </fieldset>
              <mk-form-field label="Type the pool name to confirm" hint="The chosen disks are formatted. There is no undo."
                ><input mkInput [value]="confirm()" (input)="confirm.set($any($event.target).value)" [placeholder]="name() || 'tank'" autocomplete="off"
              /></mk-form-field>
              <div class="actions">
                <button mkButton type="submit" tone="danger" [loading]="busy()" [disabled]="!valid()">
                  <mk-icon name="database" size="sm" /> Create {{ name() || 'the pool' }}
                </button>
                <button mkButton variant="ghost" type="button" (click)="creating.set(false)">Cancel</button>
                <span class="muted small"
                  >{{ picked().size }} disk{{ picked().size === 1 ? '' : 's' }} picked, {{ layout() }} needs at least {{ min[layout()] }}</span
                >
              </div>
            </form>
          </mk-card>
        } @else {
          <div class="toolbar">
            <button mkButton (click)="creating.set(true)"><mk-icon name="plus" /> New pool</button>
          </div>
        }
      }
    </app-storage>

    <ng-template #node let-v let-depth="depth" let-pool="pool">
      <li class="tree__row" [style.padding-left.rem]="depth * 1.25">
        <span class="mono">{{ v.name }}</span>
        @if (diskOf(v.name); as d) {
          <span class="muted small">{{ d.model ?? '' }} {{ f.bytes(d.size, 0) }}</span>
        }
        <mk-tag size="sm" [tone]="v.state === 'ONLINE' ? 'success' : v.state === 'DEGRADED' ? 'warning' : 'danger'">{{ v.state }}</mk-tag>
        @if (v.read || v.write || v.cksum) {
          <span class="muted small nowrap">{{ v.read }} read · {{ v.write }} write · {{ v.cksum }} cksum</span>
        }
        @if (v.note) {
          <span class="muted small">{{ v.note }}</span>
        }
        @if (v.children.length === 0 && v.state !== 'ONLINE' && !v.note?.includes('resilvering')) {
          <button mkButton variant="ghost" size="sm" tone="danger" (click)="replace(pool, v)">Replace…</button>
        }
      </li>
      @for (c of v.children; track c.name) {
        <ng-container *ngTemplateOutlet="node; context: { $implicit: c, depth: depth + 1, pool: pool }" />
      }
    </ng-template>
  `,
  styles: [
    `
      .pool {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
      .empty-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: var(--mk-space-2);
      }
      .pool__head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
        margin-bottom: var(--mk-space-3);
      }
      .pool__head h2,
      h2 {
        margin: 0;
        font-size: var(--mk-font-size-lg);
      }
      .spacer {
        flex: 1;
      }
      .note {
        margin: var(--mk-space-3) 0 0;
      }
      .scrubbing {
        margin-top: var(--mk-space-3);
      }
      .alert {
        display: block;
        margin-top: var(--mk-space-3);
      }
      .alert .note {
        margin: var(--mk-space-1) 0 0;
      }
      .import {
        list-style: none;
        padding: 0;
        margin: var(--mk-space-3) 0 0;
        display: grid;
        gap: var(--mk-space-2);
      }
      .import__row {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .import__note {
        margin-top: calc(-1 * var(--mk-space-1));
      }
      .tree {
        list-style: none;
        padding: 0;
        margin: var(--mk-space-4) 0 var(--mk-space-2);
        display: grid;
        gap: var(--mk-space-1);
      }
      .tree__row {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
        overflow-wrap: anywhere;
      }
      .form {
        display: grid;
        gap: var(--mk-space-3);
        margin-top: var(--mk-space-3);
      }
      .row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--mk-space-3);
      }
      .disks {
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        padding: var(--mk-space-3) var(--mk-space-4);
        display: grid;
        gap: var(--mk-space-2);
      }
      .disks legend {
        font-size: var(--mk-font-size-sm);
        color: var(--mk-text-muted);
        padding: 0 var(--mk-space-1);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .toolbar {
        margin-top: var(--mk-space-2);
      }
      .interval {
        width: 13rem;
      }
      .history {
        list-style: none;
        margin: var(--mk-space-2) 0 0;
        padding: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .history__row {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class StoragePoolsPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  protected readonly f = { ago, bytes, dateTime };
  protected readonly ms = ms;
  protected readonly layouts = LAYOUTS;
  protected readonly min = MIN;
  protected readonly scrubIntervals = SCRUB_INTERVALS;
  protected readonly q = loader<{ pools: Pool[]; disks: Disk[]; importable: ImportablePool[]; scrubPolicies: ScrubPolicy[]; jobs: Job[] }>(async () => {
    const [list, disks, importable, scrubPolicies] = await Promise.all([
      this.api.nas.pools(),
      this.api.nas.disks(),
      this.api.nas.importable().catch(() => [] as ImportablePool[]),
      this.api.nas.scrubPolicies().catch(() => [] as ScrubPolicy[]),
    ]);
    // an older agent has no scan jobs: the scan line on the pool still tells what runs now
    const [pools, jobs] = await Promise.all([
      Promise.all(list.map((p) => this.api.nas.pool(p.name))),
      Promise.all(list.map((p) => this.api.nas.poolJobs(p.name).catch(() => [] as Job[]))).then((all) => all.flat()),
    ]);
    return { pools, disks, importable, scrubPolicies, jobs };
  });
  protected readonly importing = signal<string | null>(null);
  private readonly dialog = inject(MkDialogService);
  protected readonly free = computed(() => (this.q.data()?.disks ?? []).filter((d) => d.use.kind === 'free'));
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly name = signal('');
  protected readonly layout = signal<PoolLayout>('mirror');
  protected readonly picked = signal(new Set<string>());
  protected readonly confirm = signal('');
  protected readonly valid = computed(
    () =>
      /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(this.name()) &&
      this.picked().size >= MIN[this.layout()] &&
      (this.layout() !== 'single' || this.picked().size === 1) &&
      this.confirm() === this.name(),
  );

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void this.q.run();
    // a running scan moves; poll while one does, stop when none does
    this.timer = setInterval(() => {
      const d = this.q.data();
      if (d?.jobs.some((j) => j.state === 'running') || d?.pools.some((p) => p.scrub?.state === 'running')) void this.q.run();
    }, 10_000);
    inject(DestroyRef).onDestroy(() => this.timer && clearInterval(this.timer));
  }

  reload(): void {
    void this.q.run();
  }

  diskOf(vdev: string): Disk | undefined {
    return this.q.data()?.disks.find((d) => d.id === vdev || d.ids.includes(vdev) || d.ids.some((i) => vdev.startsWith(i)));
  }

  toggle(id: string, on: boolean): void {
    this.picked.update((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async create(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.valid()) return;
    this.busy.set(true);
    try {
      const pool = await this.api.nas.createPool({ name: this.name(), layout: this.layout(), disks: [...this.picked()], confirm: this.confirm() });
      this.toast.success(`Pool ${pool.name} created, ${bytes(pool.size, 0)}`);
      this.creating.set(false);
      this.name.set('');
      this.confirm.set('');
      this.picked.set(new Set());
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async replace(pool: Pool, v: Vdev): Promise<void> {
    const ref = this.dialog.open<ReplaceDialog, Pool | undefined, ReplaceDialogData>(ReplaceDialog, {
      data: { pool, member: v.name, memberState: v.state, free: this.free() },
      size: 'md',
    });
    const result = await ref.afterClosed;
    if (!result) return;
    this.toast.success(`Rebuilding ${pool.name} onto the new disk`);
    await this.q.run();
  }

  async importPool(name: string): Promise<void> {
    this.importing.set(name);
    try {
      const p = await this.api.nas.importPool(name);
      this.toast.success(`Pool ${p.name} imported`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.importing.set(null);
    }
  }

  /** The scrub or resilver the agent is following on this pool right now. */
  runningScan(pool: string): Job | null {
    return this.q.data()?.jobs.find((j) => j.pool === pool && j.state === 'running') ?? null;
  }

  /** The last few scans that ended, newest first. */
  historyOf(pool: string): Job[] {
    return (this.q.data()?.jobs ?? []).filter((j) => j.pool === pool && j.state !== 'running').slice(0, 5);
  }

  /** The agent's default when no policy was set (an older agent answers nothing: monthly is still what it does). */
  intervalOf(pool: string): ScrubInterval {
    return this.q.data()?.scrubPolicies.find((s) => s.pool === pool)?.interval ?? 'monthly';
  }

  async setInterval(p: Pool, interval: unknown): Promise<void> {
    if (interval === this.intervalOf(p.name)) return;
    try {
      const s = await this.api.nas.setScrubPolicy(p.name, interval as ScrubInterval);
      this.toast.success(s.interval === 'off' ? `${p.name} is not scrubbed automatically any more` : `${p.name} is scrubbed ${s.interval}`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  /** The scan line in a few words: what it found and how long it took; the whole line stays on hover. */
  scanSummary(j: Job): string {
    const m = j.message ?? '';
    if (/canceled/.test(m)) return 'canceled';
    const errors = /with (\d+) errors/.exec(m);
    const took = /in (\d+):(\d\d):(\d\d)/.exec(m);
    const repaired = /(scrub repaired|resilvered) (\S+)/.exec(m);
    const parts: string[] = [];
    if (errors) parts.push(Number(errors[1]) ? `${errors[1]} error${errors[1] === '1' ? '' : 's'}` : 'no errors');
    if (repaired && repaired[2] !== '0B') parts.push(`${repaired[2]} ${j.kind === 'resilver' ? 'rebuilt' : 'repaired'}`);
    if (took) {
      const h = Number(took[1]);
      const min = Number(took[2]);
      parts.push(h ? `${h} h ${min} min` : min ? `${min} min` : `${Number(took[3])} s`);
    }
    return parts.length ? parts.join(', ') : m || (j.state === 'done' ? 'finished' : 'failed');
  }

  async scrub(p: Pool): Promise<void> {
    try {
      await this.api.nas.scrub(p.name);
      this.toast.success(`Scrub of ${p.name} started`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
