import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import type { Disk, Health, PoolSummary, Power, PowerAction, PowerScheduled, Scrub, Snapshot, System, Version } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { ago, bytes } from '../../core/format';
import { typedConfirm } from './confirm';
import { StorageShell } from './shell';
import { loader, ms } from './load';
import { Sparkline } from './sparkline';

interface Overview {
  health: Health;
  version: Version;
  disks: Disk[];
  pools: PoolSummary[];
  snapshots: Snapshot[];
  scrubs: Scrub[];
  /** null from an agent older than the power verbs. */
  power: Power | null;
}

interface Bay {
  disk: Disk;
  role: 'pool' | 'os' | 'free' | 'other';
  label: string;
  ok: boolean;
  reason: string | null;
}

/**
 * The one page to look at. On top, whether anything is wrong. Then the
 * box as it is: every disk as a bay, grouped by what it does, and each
 * pool's space as one bar with real numbers. Everything links to its page.
 */
@Component({
  selector: 'app-storage-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StorageShell, MkButton, MkIcon, MkTag, MkAlert, Sparkline],
  template: `
    <app-storage heading="Storage" [description]="subtitle()" [loading]="q.loading()" [loaded]="q.data() !== null" [error]="q.error()" (refresh)="q.run()">
      @if (q.data(); as d) {
        @if (!d.health.ok) {
          <mk-alert
            tone="danger"
            [title]="d.health.problems.length === 1 ? 'Something needs you' : d.health.problems.length + ' things need you'"
            class="alert"
          >
            <ul class="problems">
              @for (p of d.health.problems; track p) {
                <li>{{ p }}</li>
              }
            </ul>
          </mk-alert>
        }
        @if (d.health.events?.length) {
          <section class="events">
            <h2>In the last day</h2>
            <ul class="events__list">
              @for (e of d.health.events; track e.eid) {
                <li class="events__row">
                  <span class="muted" [title]="e.time">{{ f.ago(ms(e.time)) }}</span>
                  <span
                    >{{ e.summary }}
                    @if (e.count > 1) {
                      <mk-tag size="sm" tone="neutral">×{{ e.count }}</mk-tag>
                    }
                  </span>
                </li>
              }
            </ul>
          </section>
        }

        @if (vitals(); as v) {
          @if (v.now; as n) {
            <ul class="vitals" aria-label="The box right now">
              <li class="vital">
                <span class="vital__label">CPU</span>
                <span class="vital__value">{{ n.cpu }}%</span>
                <span class="vital__sub">load {{ n.load[0] }} · {{ v.cores }} cores</span>
                <app-sparkline [values]="series(v, 'cpu')" [times]="times(v)" [format]="pct" label="CPU over the last half hour" />
              </li>
              <li class="vital">
                <span class="vital__label">Memory</span>
                <span class="vital__value">{{ f.bytes(n.memory.used, 0) }}</span>
                <span class="vital__sub">of {{ f.bytes(n.memory.total, 0) }}{{ n.swap.used ? ', swap ' + f.bytes(n.swap.used, 0) : '' }}</span>
                <app-sparkline [values]="series(v, 'memoryUsed')" [times]="times(v)" [format]="gb" label="Memory used over the last half hour" />
              </li>
              <li class="vital">
                <span class="vital__label">Network</span>
                <span class="vital__value">{{ f.bytes(sum(n.net, 'rx')) }}/s</span>
                <span class="vital__sub">in · {{ f.bytes(sum(n.net, 'tx')) }}/s out</span>
                <app-sparkline [values]="series(v, 'rx')" [times]="times(v)" [format]="rate" label="Network in over the last half hour" />
              </li>
              <li class="vital">
                <span class="vital__label">Disks</span>
                <span class="vital__value">{{ f.bytes(sum(n.disks, 'read')) }}/s</span>
                <span class="vital__sub">read · {{ f.bytes(sum(n.disks, 'write')) }}/s write · {{ busiest(n) }}</span>
                <app-sparkline [values]="series(v, 'read')" [times]="times(v)" [format]="rate" label="Disk reads over the last half hour" />
              </li>
              @if (hottest(n); as t) {
                <li class="vital">
                  <span class="vital__label">Temperature</span>
                  <span class="vital__value" [class.vital__value--hot]="t.celsius >= 70">{{ t.celsius }} °C</span>
                  <span class="vital__sub">{{ t.label ?? t.sensor }} · up {{ uptime(v.uptime) }}</span>
                  <app-sparkline [values]="series(v, 'temp')" [times]="times(v)" [format]="deg" label="Hottest sensor over the last half hour" />
                </li>
              } @else {
                <li class="vital">
                  <span class="vital__label">Up</span>
                  <span class="vital__value">{{ uptime(v.uptime) }}</span>
                  <span class="vital__sub">{{ v.hostname }}</span>
                </li>
              }
            </ul>
          }
        }

        @if (d.pools.length === 0) {
          <section class="start">
            <h2>No pool yet</h2>
            <p>
              A pool is where the files live. The set-up takes the free disks below, makes them a pool, gives your files a place in this drive and keeps
              snapshots of it, in one go.
            </p>
            <div class="start__actions">
              <a mkButton routerLink="/storage/setup"><mk-icon name="database" size="sm" /> Set up this NAS</a>
              <span class="muted small"
                >or step by step on the <a routerLink="/storage/pools">Pools</a> and <a routerLink="/storage/datasets">Datasets</a> pages</span
              >
            </div>
          </section>
        }

        @for (p of d.pools; track p.name) {
          <section class="pool">
            <div class="pool__row">
              <a class="pool__name" routerLink="/storage/pools">{{ p.name }}</a>
              <mk-tag size="sm" [tone]="p.health === 'ONLINE' ? 'success' : p.health === 'DEGRADED' ? 'warning' : 'danger'">{{ p.health }}</mk-tag>
              <span class="pool__free">{{ f.bytes(p.free, 0) }} free</span>
            </div>
            <div
              class="bar"
              [class.bar--warn]="p.capacity >= 80"
              [class.bar--bad]="p.capacity >= 90"
              role="img"
              [attr.aria-label]="p.capacity + '% of ' + f.bytes(p.size, 0) + ' used'"
            >
              <span class="bar__fill" [style.width.%]="Math.max(p.capacity, p.allocated > 0 ? 0.6 : 0)"></span>
            </div>
            <div class="pool__meta muted">
              <span>{{ f.bytes(p.allocated, 0) }} used of {{ f.bytes(p.size, 0) }}</span>
              <span>{{ scrubLine(p.name) }}</span>
              <span>{{ snapshotLine(p.name) }}</span>
            </div>
          </section>
        }

        <h2 class="bays__title">Disks in the box</h2>
        <ul class="bays">
          @for (b of bays(); track b.disk.id) {
            <li
              class="bay"
              [class.bay--pool]="b.role === 'pool'"
              [class.bay--os]="b.role === 'os'"
              [class.bay--free]="b.role === 'free'"
              [class.bay--other]="b.role === 'other'"
              [class.bay--bad]="!b.ok"
            >
              <a class="bay__link" routerLink="/storage/disks">
                <div class="bay__top">
                  <span class="bay__size">{{ f.bytes(b.disk.size, 0) }}</span>
                  <span class="bay__kind">{{ b.disk.rotational ? 'HDD' : 'SSD' }}</span>
                  <mk-icon [name]="b.ok ? 'shield-check' : 'circle-alert'" size="sm" class="bay__health" />
                </div>
                <div class="bay__model">{{ b.disk.model ?? b.disk.id }}</div>
                <div class="bay__id mono">{{ b.disk.id }}</div>
                <div class="bay__role">
                  {{ b.label }}
                  @if (b.disk.smart?.temperature !== null && b.disk.smart?.temperature !== undefined) {
                    <span class="bay__temp" [class.bay__temp--hot]="(b.disk.smart?.temperature ?? 0) >= 50">{{ b.disk.smart?.temperature }} °C</span>
                  }
                </div>
                @if (b.reason) {
                  <div class="bay__reason">{{ b.reason }}</div>
                }
              </a>
            </li>
          }
        </ul>

        <section class="system">
          <h2>System</h2>
          @if (going(); as g) {
            <mk-alert
              tone="info"
              [title]="g.action === 'reboot' ? d.version.hostname + ' is restarting' : d.version.hostname + ' is shutting down'"
              class="alert"
            >
              {{
                g.action === 'reboot'
                  ? 'The drive is unreachable for a minute or two; reload the page once it is back.'
                  : 'It stays off until someone presses its power button.'
              }}
            </mk-alert>
          } @else if (d.power?.restartNeeded) {
            <mk-alert tone="warning" title="A restart is needed" class="alert">
              Ubuntu's updates{{ d.power?.packages?.length ? ' (' + d.power!.packages.join(', ') + ')' : '' }} take effect after a reboot.
            </mk-alert>
          }
          <div class="system__row">
            <p class="system__versions muted">
              mk-nas {{ d.version.agent }} · mk-drive {{ drive.meta()?.version ?? '?' }} on {{ d.version.hostname }} · {{ d.version.zfs ?? 'no zfs'
              }}{{ d.version.smartctl ? ' · smartctl ' + d.version.smartctl : ' · no smartctl' }}
            </p>
            @if (d.power) {
              <div class="system__actions">
                <button mkButton variant="outline" size="sm" [disabled]="!!going()" [loading]="busy() === 'reboot'" (click)="powerAction('reboot')">
                  <mk-icon name="rotate-cw" size="sm" /> Reboot
                </button>
                <button
                  mkButton
                  variant="ghost"
                  tone="danger"
                  size="sm"
                  [disabled]="!!going()"
                  [loading]="busy() === 'shutdown'"
                  (click)="powerAction('shutdown')"
                >
                  <mk-icon name="power-off" size="sm" /> Shut down
                </button>
              </div>
            } @else {
              <span class="muted small">Upgrade mk-nas to reboot or shut down from here.</span>
            }
          </div>
        </section>
      }
    </app-storage>
  `,
  styles: [
    `
      .alert {
        display: block;
        margin-bottom: var(--mk-space-6);
      }
      .problems {
        margin: 0;
        padding-left: 1.2em;
      }
      .events {
        margin-bottom: var(--mk-space-6);
      }
      .vitals {
        list-style: none;
        margin: 0 0 var(--mk-space-6);
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
        gap: var(--mk-space-3);
      }
      .vital {
        display: grid;
        gap: 2px;
        padding: var(--mk-space-3);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
      }
      .vital__label {
        font-size: var(--mk-font-size-sm);
        color: var(--mk-text-muted);
      }
      .vital__value {
        font-size: var(--mk-font-size-lg);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .vital__value--hot {
        color: var(--mk-warning);
      }
      .vital__sub {
        font-size: var(--mk-font-size-xs);
        color: var(--mk-text-muted);
        overflow-wrap: anywhere;
      }
      .events__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .events__row {
        display: grid;
        grid-template-columns: 5.5rem 1fr;
        gap: var(--mk-space-2);
        align-items: baseline;
      }
      .events__row mk-tag {
        margin-left: var(--mk-space-2);
        vertical-align: middle;
      }
      h2 {
        font-size: var(--mk-font-size-lg);
        margin: 0 0 var(--mk-space-2);
      }
      .start {
        padding: var(--mk-space-5) var(--mk-space-6);
        border: 1px dashed var(--mk-border);
        border-radius: var(--mk-radius-lg);
        margin-bottom: var(--mk-space-6);
        max-width: 60ch;
      }
      .start p {
        margin: 0;
      }
      .start__actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--mk-space-2) var(--mk-space-4);
        margin-top: var(--mk-space-4);
      }
      .start a:not([mkButton]) {
        color: var(--mk-primary-subtle-text);
      }
      .start__actions .small {
        font-size: var(--mk-font-size-sm);
      }
      .pool {
        margin-bottom: var(--mk-space-6);
      }
      .pool__row {
        display: flex;
        align-items: baseline;
        gap: var(--mk-space-3);
        margin-bottom: var(--mk-space-2);
      }
      .pool__name {
        font-size: var(--mk-font-size-xl);
        font-weight: 600;
        color: inherit;
        text-decoration: none;
      }
      .pool__name:hover {
        text-decoration: underline;
      }
      .pool__free {
        margin-left: auto;
        font-size: var(--mk-font-size-sm);
        color: var(--mk-text-muted);
      }
      .bar {
        height: 14px;
        border-radius: 4px;
        background: var(--mk-border-subtle);
        overflow: hidden;
      }
      .bar__fill {
        display: block;
        height: 100%;
        background: var(--mk-primary);
        border-radius: inherit;
        transition: width 400ms ease;
      }
      .bar--warn .bar__fill {
        background: var(--mk-warning);
      }
      .bar--bad .bar__fill {
        background: var(--mk-danger);
      }
      .pool__meta {
        display: flex;
        gap: var(--mk-space-5);
        flex-wrap: wrap;
        font-size: var(--mk-font-size-sm);
        margin-top: var(--mk-space-2);
      }
      .bays__title {
        margin-top: var(--mk-space-2);
      }
      .bays {
        list-style: none;
        padding: 0;
        margin: 0 0 var(--mk-space-6);
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
        gap: var(--mk-space-3);
      }
      .bay {
        border: 1px solid var(--mk-border-subtle);
        border-left: 4px solid var(--mk-border);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
        min-width: 0;
      }
      .bay--pool {
        border-left-color: var(--mk-primary);
      }
      .bay--os {
        border-left-color: var(--mk-text-muted);
      }
      .bay--free {
        border-left-color: var(--mk-success);
        border-style: dashed;
        border-left-style: solid;
      }
      .bay--other {
        border-left-color: var(--mk-warning);
      }
      .bay--bad {
        border-color: var(--mk-danger);
      }
      .bay__link {
        display: block;
        padding: var(--mk-space-3) var(--mk-space-4);
        color: inherit;
        text-decoration: none;
      }
      .bay__link:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
        outline-offset: var(--mk-focus-ring-offset);
        border-radius: var(--mk-radius-lg);
      }
      .bay__top {
        display: flex;
        align-items: baseline;
        gap: var(--mk-space-2);
      }
      .bay__size {
        font-size: var(--mk-font-size-xl);
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .bay__kind {
        font-size: var(--mk-font-size-xs);
        color: var(--mk-text-muted);
      }
      .bay__health {
        margin-left: auto;
        color: var(--mk-success);
        align-self: center;
      }
      .bay--bad .bay__health {
        color: var(--mk-danger);
      }
      .bay__model {
        margin-top: var(--mk-space-1);
        font-size: var(--mk-font-size-sm);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bay__id {
        font-size: var(--mk-font-size-xs);
        color: var(--mk-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bay__role {
        margin-top: var(--mk-space-2);
        font-size: var(--mk-font-size-sm);
        display: flex;
        justify-content: space-between;
        gap: var(--mk-space-2);
      }
      .bay__temp {
        color: var(--mk-text-muted);
      }
      .bay__temp--hot {
        color: var(--mk-warning);
      }
      .bay__reason {
        margin-top: var(--mk-space-1);
        font-size: var(--mk-font-size-xs);
        color: var(--mk-danger);
      }
      .system__row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--mk-space-2) var(--mk-space-4);
      }
      .system__versions {
        margin: 0;
        font-size: var(--mk-font-size-sm);
        overflow-wrap: anywhere;
      }
      .system__actions {
        display: flex;
        gap: var(--mk-space-2);
        margin-left: auto;
      }
      .system .small {
        font-size: var(--mk-font-size-sm);
      }
    `,
  ],
})
export class StorageOverviewPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly drive = inject(DriveService);
  protected readonly f = { ago, bytes };
  protected readonly ms = ms;
  protected readonly Math = Math;
  protected readonly q = loader<Overview>(async () => {
    const [health, version, disks, pools, snapshots, scrubs, power] = await Promise.all([
      this.api.nas.health(),
      this.api.nas.version(),
      this.api.nas.disks(),
      this.api.nas.pools(),
      this.api.nas.snapshots(),
      this.api.nas.scrubs().catch(() => [] as Scrub[]),
      this.api.nas.power().catch(() => null),
    ]);
    return { health, version, disks, pools, snapshots, scrubs, power };
  });

  protected readonly subtitle = computed(() => {
    const d = this.q.data();
    if (!d) return '';
    const size = d.pools.reduce((n, p) => n + p.size, 0);
    const used = d.pools.reduce((n, p) => n + p.allocated, 0);
    if (!d.pools.length) return `${d.disks.length} disk${d.disks.length === 1 ? '' : 's'} in the box, no pool yet.`;
    return `${bytes(used, 0)} of ${bytes(size, 0)} used across ${d.pools.length} pool${d.pools.length === 1 ? '' : 's'}, ${d.disks.length} disks in the box.`;
  });

  /** Disks grouped as the eye wants them: pool members by pool, then the OS disk, then what is free, then what carries something else. */
  protected readonly bays = computed<Bay[]>(() => {
    const d = this.q.data();
    if (!d) return [];
    const order = { pool: 0, os: 1, free: 2, other: 3 };
    return d.disks
      .map<Bay>((disk) => {
        const h = d.health.disks.find((x) => x.id === disk.id);
        const foreign = disk.use.kind === 'pool' && disk.use.imported === false;
        // a pool from another system is not this box's: shown with the disks that carry something else
        const role = foreign ? 'other' : disk.use.kind;
        const label = foreign
          ? `Old pool ${(disk.use as { pool: string }).pool}, not imported`
          : role === 'pool'
            ? `In pool ${(disk.use as { pool: string }).pool}`
            : role === 'os'
              ? 'Operating system'
              : role === 'free'
                ? 'Free'
                : `Carries ${(disk.use as { what: string }).what}`;
        return { disk, role, label, ok: h ? h.ok : true, reason: h?.reason ?? null };
      })
      .sort(
        (a, b) =>
          order[a.role] - order[b.role] ||
          (a.role === 'pool' && b.role === 'pool' ? (a.disk.use as { pool: string }).pool.localeCompare((b.disk.use as { pool: string }).pool) : 0) ||
          a.disk.id.localeCompare(b.disk.id),
      );
  });

  /** The glance: polled every 5 s while the page is open; an older agent without it leaves the row out. */
  protected readonly vitals = signal<System | null>(null);

  constructor() {
    void this.q.run();
    const poll = () =>
      this.api.nas
        .system()
        .then((s) => this.vitals.set(s))
        .catch(() => this.vitals.set(null));
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** Set once a reboot or shutdown was accepted: the buttons stay off, the page says what happens next. */
  protected readonly going = signal<PowerScheduled | null>(null);
  protected readonly busy = signal<PowerAction | null>(null);

  /** Reboot or shut down: asks the agent what is running right now, says so, and wants the box's name typed. */
  async powerAction(action: PowerAction): Promise<void> {
    const host = this.q.data()?.version.hostname;
    if (!host) return;
    this.busy.set(action);
    try {
      const pw = await this.api.nas.power();
      const parts =
        action === 'reboot'
          ? ['The box restarts; the drive, shares and copies are unreachable for a minute or two.']
          : pw.viaTunnel
            ? [
                'The box turns off. You are connected from outside, through the tunnel: nobody can turn it back on from here — it stays off until someone presses its power button.',
              ]
            : ['The box turns off and stays off until someone presses its power button.'];
      if (pw.busy.length)
        parts.push(`Running now: ${pw.busy.join('; ')}. Scrubs, rebuilds and copies carry on after the restart; a SMART test has to be started again.`);
      const confirm = await typedConfirm(this.dialog, {
        title: action === 'reboot' ? `Reboot ${host}?` : `Shut down ${host}?`,
        message: parts.join(' '),
        name: host,
        confirmText: action === 'reboot' ? 'Reboot' : 'Shut down',
      });
      if (confirm === null) return;
      if (confirm === '') return void this.toast.danger(`The name did not match; ${host} keeps running`);
      this.going.set(await (action === 'reboot' ? this.api.nas.reboot(confirm) : this.api.nas.shutdown(confirm)));
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }

  protected readonly pct = (v: number) => `${Math.round(v)}%`;
  protected readonly gb = (v: number) => bytes(v, 1);
  protected readonly rate = (v: number) => `${bytes(v)}/s`;
  protected readonly deg = (v: number) => `${Math.round(v)} °C`;

  series(v: System, key: 'cpu' | 'memoryUsed' | 'rx' | 'read' | 'temp'): (number | null)[] {
    return v.history.map((p) => p[key]);
  }

  times(v: System): string[] {
    return v.history.map((p) => p.at);
  }

  sum<K extends string>(rows: Record<K, number>[], key: K): number {
    return rows.reduce((n, r) => n + r[key], 0);
  }

  hottest(n: NonNullable<System['now']>): { sensor: string; label: string | null; celsius: number } | null {
    return n.temps.length ? n.temps.reduce((a, b) => (b.celsius > a.celsius ? b : a)) : null;
  }

  /** The busiest disk, named by the pool it serves when it does. */
  busiest(n: NonNullable<System['now']>): string {
    if (!n.disks.length) return 'no disks';
    const top = n.disks.reduce((a, b) => (b.busy > a.busy ? b : a));
    const known = this.vitals()?.disks.find((d) => d.dev === top.dev);
    return `${known?.pool ?? top.dev} ${top.busy}% busy`;
  }

  uptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    return h >= 48 ? `${Math.floor(h / 24)} days` : h >= 1 ? `${h} h` : `${Math.floor(seconds / 60)} min`;
  }

  scrubLine(pool: string): string {
    const s = this.q.data()?.scrubs.find((x) => x.pool === pool);
    if (!s || s.state === 'none') return 'Never scrubbed';
    if (s.state === 'running') return `${s.kind === 'resilver' ? 'Rebuilding' : 'Scrub running'}${s.percent !== null ? `, ${s.percent}%` : ''}`;
    return `${s.kind === 'resilver' ? 'Rebuilt' : 'Scrubbed'} ${s.finishedAt ? ago(ms(s.finishedAt)) : ''}${s.errors ? `, ${s.errors} errors` : ''}`;
  }

  snapshotLine(pool: string): string {
    const mine = (this.q.data()?.snapshots ?? []).filter((s) => s.dataset === pool || s.dataset.startsWith(pool + '/'));
    if (mine.length === 0) return 'No snapshots';
    const last = mine.reduce((a, b) => (ms(a.creation) > ms(b.creation) ? a : b));
    return `${mine.length} snapshot${mine.length === 1 ? '' : 's'}, last ${ago(ms(last.creation))}`;
  }
}
