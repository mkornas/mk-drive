import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkCard, MkTag } from '@mk-kit/ui/data';
import { MkAlert } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkStep, MkStepper } from '@mk-kit/ui/navigation';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import type { Disk, PoolLayout, PoolSummary } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { bytes } from '../../core/format';
import { StorageShell } from './shell';
import { loader } from './load';

/** The zpool rule for a pool name, and the rule for a child dataset (the agent checks both again). */
const POOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const CHILD_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MIN: Record<PoolLayout, number> = { single: 1, mirror: 2, raidz1: 3, raidz2: 4 };
/** How many disks may fail before files are lost. */
const SURVIVES = (layout: PoolLayout, n: number): number => ({ single: 0, mirror: n - 1, raidz1: 1, raidz2: 2 })[layout];
/** The first-install guide's start: a day of hours, two weeks of days, two months of weeks, half a year of months. */
const POLICY = { hourly: 24, daily: 14, weekly: 8, monthly: 6 };

type TaskState = 'waiting' | 'running' | 'done' | 'failed';
interface Task {
  key: 'pool' | 'dataset' | 'policy';
  label: string;
  state: TaskState;
  error?: string;
}

/**
 * Storage → Set up: an empty box gets one flow instead of three pages. Pick free disks,
 * name the pool and the first place for files, type the pool's name once, and the wizard
 * does what Pools, Datasets and the snapshot dialog would: make the pool, make the dataset
 * as a location of this drive, give it automatic snapshots. A step that fails can be tried
 * again without redoing the ones before it.
 */
@Component({
  selector: 'app-storage-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    StorageShell,
    MkStepper,
    MkStep,
    MkCard,
    MkTag,
    MkCheckbox,
    MkFormField,
    MkInput,
    MkSelect,
    MkButton,
    MkIcon,
    MkAlert,
    MkEmptyState,
    MkSpinner,
  ],
  template: `
    <app-storage
      heading="Set up this NAS"
      description="A pool from the free disks, a place for your files in this drive, and snapshots that keep them. The same steps the Pools and Datasets pages take, in one go."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="reload()"
    >
      @if (q.data(); as data) {
        @if (phase() === 'done') {
          <mk-card class="done">
            <div class="done__mark" aria-hidden="true"><mk-icon name="check" /></div>
            <h2>{{ poolName() }} is ready</h2>
            <p class="lead">
              A {{ layoutWord() }} of {{ picked().size }} disk{{ picked().size === 1 ? '' : 's' }}, about {{ f.bytes(usable(), 0) }} for files.
              @if (asLocation()) {
                <strong>{{ datasetLeaf() }}</strong> is in the sidebar; upload, browse and share from there.
              } @else {
                {{ datasetName() }} is made; offer it as a location from the Datasets page when you want it in the drive.
              }
              @if (withSnapshots()) {
                Snapshots are taken every hour, and kept for a day, two weeks, two months and half a year.
              }
            </p>
            <div class="actions">
              @if (asLocation()) {
                <a mkButton [routerLink]="['/d', datasetLeaf()]"><mk-icon name="folder-open" size="sm" /> Open {{ datasetLeaf() }}</a>
              } @else {
                <a mkButton routerLink="/storage/datasets"><mk-icon name="layers" size="sm" /> See the dataset</a>
              }
              <a mkButton variant="outline" routerLink="/storage/shares"><mk-icon name="globe" size="sm" /> Reach it from other computers</a>
              <a mkButton variant="ghost" routerLink="/storage/replication">Keep the box's settings safe</a>
            </div>
          </mk-card>
        } @else if (fresh() && data.pools.length > 0) {
          <mk-empty-state
            icon="database"
            title="This box already has a pool"
            description="The wizard is for an empty box. Add disks, datasets and snapshots from their own pages."
          >
            <div mkEmptyStateActions class="actions">
              <a mkButton routerLink="/storage/pools">Pools</a>
              <a mkButton variant="outline" routerLink="/storage/datasets">Datasets</a>
            </div>
          </mk-empty-state>
        } @else if (fresh() && free().length === 0) {
          <mk-empty-state icon="hard-drive" title="No free disk" [description]="noFreeLine()">
            <div mkEmptyStateActions class="actions">
              <a mkButton routerLink="/storage/disks">Disks</a>
              @if (foreign().length) {
                <a mkButton variant="outline" routerLink="/storage/pools">Pools</a>
              }
            </div>
          </mk-empty-state>
        } @else {
          <mk-stepper linear [(selectedIndex)]="step" [orientation]="narrow() ? 'vertical' : 'horizontal'" class="stepper">
            <mk-step label="Disks" [description]="picked().size ? picked().size + ' picked' : 'Pick the free ones'" [completed]="disksValid()">
              <p class="intro">
                These disks carry nothing. The ones you pick are formatted into one pool; the rest of the box is not touched.
                @if (others() > 0) {
                  <span class="muted"
                    >{{ others() }} more {{ others() === 1 ? 'disk is' : 'disks are' }} not offered: the one the system runs from, or one that carries something
                    (<a routerLink="/storage/disks">Disks</a> can wipe it).</span
                  >
                }
              </p>
              <ul class="disks">
                @for (d of free(); track d.id) {
                  <li class="disk" [class.disk--on]="picked().has(d.id)">
                    <mk-checkbox [checked]="picked().has(d.id)" [disabled]="done('pool')" (checkedChange)="toggle(d.id, $event)">
                      <span class="disk__size">{{ f.bytes(d.size, 0) }}</span>
                      <span class="disk__model">{{ d.model ?? 'Unknown model' }}</span>
                      <span class="disk__meta muted">{{ d.rotational ? 'Hard disk' : 'SSD' }} · {{ d.serial ?? d.dev }}</span>
                    </mk-checkbox>
                    @if (d.smart?.passed === false) {
                      <mk-tag size="sm" tone="danger">SMART failed</mk-tag>
                    } @else if ((d.smart?.pending ?? 0) > 0 || (d.smart?.reallocated ?? 0) > 0) {
                      <mk-tag size="sm" tone="warning">Worn sectors</mk-tag>
                    }
                  </li>
                }
              </ul>
              @if (picked().size > 0) {
                <div class="layout">
                  <mk-form-field label="How the disks work together">
                    <mk-select [options]="layoutOptions()" [value]="layout()" [disabled]="done('pool')" (valueChange)="layoutChoice.set($any($event))" />
                  </mk-form-field>
                  <p class="sum">
                    <strong>About {{ f.bytes(usable(), 0) }} for files.</strong>
                    @if (survives() === 0) {
                      <span class="warn">No disk may fail: one broken disk loses the files.</span>
                    } @else {
                      {{ survives() === 1 ? 'One disk' : survives() + ' disks' }} may fail without losing a file.
                    }
                  </p>
                </div>
              }
              <div class="nav">
                <button mkButton type="button" [disabled]="!disksValid()" (click)="step.set(1)">Next</button>
              </div>
            </mk-step>

            <mk-step label="Names" description="The pool and your files" [completed]="disksValid() && namesValid()">
              <div class="fields">
                <mk-form-field
                  label="Pool name"
                  hint="tank is the ZFS custom. Letters, digits and - _ . : ; it starts with a letter."
                  [error]="poolNameError()"
                >
                  <input
                    mkInput
                    [value]="poolName()"
                    [disabled]="done('pool')"
                    (input)="poolName.set($any($event.target).value.trim())"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </mk-form-field>
                <mk-form-field label="A place for your files" [hint]="'Made as ' + datasetName() + '.'" [error]="datasetError()">
                  <input mkInput [value]="datasetLeaf()" (input)="datasetLeaf.set($any($event.target).value.trim())" autocomplete="off" spellcheck="false" />
                </mk-form-field>
              </div>
              <div class="checks">
                <mk-checkbox [checked]="asLocation()" (checkedChange)="asLocation.set($event)">
                  Offer it in this drive's sidebar
                  <span class="muted">— upload, browse and share it here. Leave it off for a dataset only Finder or Explorer should see.</span>
                </mk-checkbox>
                <mk-checkbox [checked]="withSnapshots()" (checkedChange)="withSnapshots.set($event)">
                  Take automatic snapshots
                  <span class="muted"
                    >— hourly, kept 24 hours, 14 days, 8 weeks and 6 months. They cost nothing until files change and bring back a deleted file.</span
                  >
                </mk-checkbox>
              </div>
              <div class="nav">
                <button mkButton variant="ghost" type="button" (click)="step.set(0)">Back</button>
                <button mkButton type="button" [disabled]="!namesValid()" (click)="step.set(2)">Next</button>
              </div>
            </mk-step>

            <mk-step label="Create" description="Check and confirm" [completed]="false">
              <dl class="review">
                <dt>Pool</dt>
                <dd>
                  <strong>{{ poolName() }}</strong
                  >, a {{ layoutWord() }} of {{ picked().size }} disk{{ picked().size === 1 ? '' : 's' }}, about
                  {{ f.bytes(usable(), 0) }}
                </dd>
                <dt>Disks</dt>
                <dd>
                  @for (d of pickedDisks(); track d.id) {
                    <span class="review__disk">{{ f.bytes(d.size, 0) }} {{ d.model ?? '' }}</span>
                  }
                </dd>
                <dt>Files</dt>
                <dd>
                  <strong>{{ datasetName() }}</strong
                  >{{ asLocation() ? ', in the sidebar as ' + datasetLeaf() : ', not in the drive' }}
                </dd>
                <dt>Snapshots</dt>
                <dd>{{ withSnapshots() ? '24 hourly, 14 daily, 8 weekly, 6 monthly' : 'None for now' }}</dd>
              </dl>

              @if (phase() === 'form' && !done('pool')) {
                <mk-alert tone="danger" title="The picked disks are formatted" class="alert">
                  Whatever is on them is gone, and there is no undo. Type <strong>{{ poolName() }}</strong> to confirm.
                </mk-alert>
                <mk-form-field label="Type the pool name">
                  <input
                    mkInput
                    [value]="confirm()"
                    (input)="confirm.set($any($event.target).value)"
                    [placeholder]="poolName()"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </mk-form-field>
              }

              @if (phase() !== 'form' || tasksStarted()) {
                <ul class="tasks" aria-live="polite">
                  @for (t of tasks(); track t.key) {
                    <li class="task" [attr.data-state]="t.state">
                      <span class="task__icon" aria-hidden="true">
                        @switch (t.state) {
                          @case ('running') {
                            <mk-spinner size="sm" />
                          }
                          @case ('done') {
                            <mk-icon name="check" size="sm" />
                          }
                          @case ('failed') {
                            <mk-icon name="close" size="sm" />
                          }
                          @default {
                            <span class="task__dot"></span>
                          }
                        }
                      </span>
                      <span class="task__label">{{ t.label }}</span>
                      @if (t.error) {
                        <span class="task__error">{{ t.error }}</span>
                      }
                    </li>
                  }
                </ul>
              }

              <div class="nav">
                @if (!done('pool')) {
                  <button mkButton variant="ghost" type="button" [disabled]="phase() === 'running'" (click)="step.set(1)">Back</button>
                }
                @if (failed()) {
                  <button mkButton type="button" (click)="run()"><mk-icon name="refresh-cw" size="sm" /> Try again</button>
                  <a mkButton variant="ghost" routerLink="/storage/datasets">Finish on the Datasets page</a>
                } @else {
                  <button mkButton type="button" tone="danger" [loading]="phase() === 'running'" [disabled]="!canCreate()" (click)="run()">
                    <mk-icon name="database" size="sm" /> Create {{ poolName() || 'the pool' }}
                  </button>
                }
              </div>
            </mk-step>
          </mk-stepper>
        }
      }
    </app-storage>
  `,
  styles: [
    `
      .stepper {
        display: block;
        max-width: 760px;
      }
      .intro {
        margin: 0 0 var(--mk-space-4);
        max-width: 64ch;
        line-height: var(--mk-line-height-relaxed);
      }
      .intro a {
        color: var(--mk-primary-subtle-text);
      }
      .intro .muted {
        display: block;
        margin-top: var(--mk-space-2);
        font-size: var(--mk-font-size-sm);
      }
      .disks {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
        gap: var(--mk-space-3);
      }
      .disk {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--mk-space-2);
        padding: var(--mk-space-3) var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
        transition:
          border-color var(--mk-duration-fast),
          background var(--mk-duration-fast);
      }
      .disk--on {
        border-color: var(--mk-primary);
        background: var(--mk-primary-subtle);
      }
      .disk__size {
        display: block;
        font-weight: var(--mk-font-weight-bold);
        font-size: var(--mk-font-size-lg);
        font-variant-numeric: tabular-nums;
      }
      .disk__model {
        display: block;
      }
      .disk__meta {
        display: block;
        font-size: var(--mk-font-size-xs);
      }
      .layout {
        margin-top: var(--mk-space-5);
        display: grid;
        gap: var(--mk-space-2);
        max-width: 520px;
      }
      .sum {
        margin: 0;
      }
      .warn {
        color: var(--mk-danger);
      }
      .fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
        gap: var(--mk-space-4);
      }
      .fields input[mkInput] {
        width: 100%;
        box-sizing: border-box;
      }
      .checks {
        display: grid;
        gap: var(--mk-space-3);
        margin-top: var(--mk-space-5);
      }
      .nav {
        display: flex;
        flex-wrap: wrap;
        gap: var(--mk-space-2);
        justify-content: flex-end;
        margin-top: var(--mk-space-6);
      }
      .review {
        display: grid;
        grid-template-columns: 7rem 1fr;
        gap: var(--mk-space-2) var(--mk-space-4);
        margin: 0 0 var(--mk-space-5);
      }
      .review dt {
        color: var(--mk-text-muted);
      }
      .review dd {
        margin: 0;
        min-width: 0;
      }
      .review__disk {
        display: block;
      }
      .alert {
        display: block;
        margin-bottom: var(--mk-space-3);
      }
      .tasks {
        list-style: none;
        margin: var(--mk-space-5) 0 0;
        padding: 0;
        display: grid;
        gap: var(--mk-space-2);
      }
      .task {
        display: grid;
        grid-template-columns: 20px 1fr;
        align-items: center;
        gap: var(--mk-space-1) var(--mk-space-3);
      }
      .task__icon {
        display: grid;
        place-items: center;
        width: 20px;
        height: 20px;
      }
      .task__dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--mk-border-strong);
      }
      .task[data-state='waiting'] .task__label {
        color: var(--mk-text-muted);
      }
      .task[data-state='done'] .task__icon {
        color: var(--mk-success);
      }
      .task[data-state='failed'] .task__icon,
      .task__error {
        color: var(--mk-danger);
      }
      .task__error {
        grid-column: 2;
        font-size: var(--mk-font-size-sm);
      }
      .done {
        display: block;
        max-width: 640px;
      }
      .done__mark {
        display: grid;
        place-items: center;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: var(--mk-primary);
        color: var(--mk-primary-contrast);
        margin-bottom: var(--mk-space-4);
      }
      .done h2 {
        margin: 0 0 var(--mk-space-2);
        font-size: var(--mk-font-size-2xl);
      }
      .lead {
        margin: 0;
        line-height: var(--mk-line-height-relaxed);
        max-width: 60ch;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--mk-space-2);
        margin-top: var(--mk-space-5);
      }
      @media (max-width: 560px) {
        .review {
          grid-template-columns: 1fr;
          gap: 0;
        }
        .review dd {
          margin-bottom: var(--mk-space-3);
        }
        .nav > * {
          flex: 1 1 auto;
        }
      }
    `,
  ],
})
export class StorageSetupPage {
  private readonly api = inject(ApiService);
  private readonly drive = inject(DriveService);
  protected readonly f = { bytes };
  protected readonly q = loader<{ disks: Disk[]; pools: PoolSummary[] }>(async () => {
    const [disks, pools] = await Promise.all([this.api.nas.disks(), this.api.nas.pools()]);
    return { disks, pools };
  });

  protected readonly step = signal(0);
  /** A phone: the three step headers do not fit side by side, so they stack with their panels. */
  protected readonly narrow = signal(false);
  protected readonly phase = signal<'form' | 'running' | 'done'>('form');
  protected readonly picked = signal(new Set<string>());
  /** The layout the person chose; null follows the recommendation for the number of disks. */
  protected readonly layoutChoice = signal<PoolLayout | null>(null);
  protected readonly poolName = signal('tank');
  protected readonly datasetLeaf = signal('files');
  protected readonly asLocation = signal(true);
  protected readonly withSnapshots = signal(true);
  protected readonly confirm = signal('');
  protected readonly tasks = signal<Task[]>([]);

  protected readonly free = computed(() => (this.q.data()?.disks ?? []).filter((d) => d.use.kind === 'free'));
  protected readonly others = computed(() => (this.q.data()?.disks.length ?? 0) - this.free().length);
  /** Disks with a ZFS label no pool here uses: an old pool from another system, wipeable on the Disks page. */
  protected readonly foreign = computed(() => (this.q.data()?.disks ?? []).filter((d) => d.use.kind === 'pool' && d.use.imported === false));
  protected readonly noFreeLine = computed(() =>
    this.foreign().length
      ? `${this.foreignLine()} Wipe them on the Disks page to use them for a new pool (that pool's data is gone then), or import it from the Pools page to keep it.`
      : 'A pool needs at least one disk that carries nothing. A disk with old partitions is wiped on the Disks page first; the disk the system runs from is never offered.',
  );
  protected readonly foreignLine = computed(() => {
    const disks = this.foreign();
    const pools = [...new Set(disks.map((d) => (d.use as { pool: string }).pool))];
    const which = pools.length === 1 ? `the pool ${pools[0]}` : `the pools ${pools.join(', ')}`;
    return `${disks.length === 1 ? 'One disk carries' : `${disks.length} disks carry`} ${which} from another system, not imported here.`;
  });
  protected readonly pickedDisks = computed(() => this.free().filter((d) => this.picked().has(d.id)));

  private readonly allowed = computed<PoolLayout[]>(() => {
    const n = this.picked().size;
    if (n === 1) return ['single'];
    return (['mirror', 'raidz1', 'raidz2'] as PoolLayout[]).filter((l) => n >= MIN[l]);
  });
  protected readonly layout = computed<PoolLayout>(() => {
    const choice = this.layoutChoice();
    if (choice && this.allowed().includes(choice)) return choice;
    const n = this.picked().size;
    return n <= 1 ? 'single' : n === 2 ? 'mirror' : n === 3 ? 'raidz1' : 'raidz2';
  });
  protected readonly usable = computed(() => {
    const disks = this.pickedDisks();
    if (!disks.length) return 0;
    const smallest = Math.min(...disks.map((d) => d.size));
    return { single: smallest, mirror: smallest, raidz1: (disks.length - 1) * smallest, raidz2: (disks.length - 2) * smallest }[this.layout()];
  });
  protected readonly survives = computed(() => SURVIVES(this.layout(), this.picked().size));
  protected readonly layoutOptions = computed<MkSelectOption[]>(() => {
    const n = this.picked().size;
    const label: Record<PoolLayout, string> = {
      single: 'One disk — no copy, for scratch',
      mirror: `Mirror — every disk a full copy, ${n - 1} may fail`,
      raidz1: 'raidz1 — striped with parity, one may fail',
      raidz2: 'raidz2 — striped with double parity, two may fail',
    };
    return this.allowed().map((l) => ({ label: label[l], value: l }));
  });
  protected readonly layoutWord = computed(() => ({ single: 'single disk', mirror: 'mirror', raidz1: 'raidz1', raidz2: 'raidz2' })[this.layout()]);

  protected readonly datasetName = computed(() => `${this.poolName() || 'tank'}/${this.datasetLeaf() || 'files'}`);
  protected readonly poolNameError = computed(() =>
    this.poolName() && !POOL_NAME.test(this.poolName()) ? 'Letters, digits and - _ . : ; it starts with a letter' : '',
  );
  protected readonly datasetError = computed(() => {
    const leaf = this.datasetLeaf();
    if (!leaf) return '';
    if (!CHILD_NAME.test(leaf)) return 'Letters, digits and - _ . : ; no / and no leading dot';
    if (this.asLocation() && this.drive.locations().some((l) => l.name === leaf)) return `This drive already has a location called ${leaf}`;
    return '';
  });

  protected readonly disksValid = computed(() => this.picked().size >= MIN[this.layout()]);
  protected readonly namesValid = computed(() => POOL_NAME.test(this.poolName()) && !!this.datasetLeaf() && !this.datasetError());
  protected readonly tasksStarted = computed(() => this.tasks().some((t) => t.state !== 'waiting'));
  /** Nothing made yet: the page may still say the box is not empty, or has no free disk. */
  protected readonly fresh = computed(() => this.phase() === 'form' && !this.tasksStarted());
  protected readonly failed = computed(() => this.tasks().some((t) => t.state === 'failed'));
  protected readonly canCreate = computed(() => this.namesValid() && (this.done('pool') || (this.disksValid() && this.confirm() === this.poolName())));

  constructor() {
    const media = typeof matchMedia === 'function' ? matchMedia('(max-width: 640px)') : null;
    if (media) {
      const sync = () => this.narrow.set(media.matches);
      sync();
      media.addEventListener('change', sync);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', sync));
    }
    void this.q.run().then(() => {
      // two free disks and nothing else to decide: the mirror the guide makes is already picked
      const free = this.free();
      if (free.length === 2 && free.every((d) => d.smart?.passed !== false)) this.picked.set(new Set(free.map((d) => d.id)));
    });
  }

  reload(): void {
    // once something is made, the lists would no longer show the disks and the empty box this flow started from
    if (this.fresh()) void this.q.run();
  }

  toggle(id: string, on: boolean): void {
    this.picked.update((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  done(key: Task['key']): boolean {
    return this.tasks().some((t) => t.key === key && t.state === 'done');
  }

  /** Make what is not made yet, in order; stop at the first failure so "Try again" picks up there. */
  async run(): Promise<void> {
    if (!this.canCreate() || this.phase() === 'running') return;
    const pool = this.poolName();
    const dataset = this.datasetName();
    const location = this.asLocation();
    const wanted: Task[] = [
      { key: 'pool', label: `Make the ${this.layoutWord()} ${pool}`, state: 'waiting' },
      { key: 'dataset', label: location ? `Make ${dataset} and offer it in the sidebar` : `Make ${dataset}`, state: 'waiting' },
      ...(this.withSnapshots() ? [{ key: 'policy' as const, label: `Automatic snapshots of ${dataset}`, state: 'waiting' as TaskState }] : []),
    ];
    // keep what is already done; a changed name or checkbox after a failure re-labels the rest
    this.tasks.set(wanted.map((t) => (this.done(t.key) ? { ...t, state: 'done' } : t)));
    this.phase.set('running');

    const steps: Record<Task['key'], () => Promise<unknown>> = {
      pool: () => this.api.nas.createPool({ name: pool, layout: this.layout(), disks: [...this.picked()], confirm: this.confirm() }),
      dataset: async () => {
        await this.api.nas.createDataset({ name: dataset, compression: 'lz4', atime: false, location });
        if (location) await this.drive.refreshLocations();
      },
      policy: () => this.api.nas.setPolicy({ dataset, ...POLICY }),
    };
    for (const t of this.tasks()) {
      if (t.state === 'done') continue;
      this.mark(t.key, 'running');
      try {
        await steps[t.key]();
        this.mark(t.key, 'done');
      } catch (e) {
        this.mark(t.key, 'failed', errorMessage(e));
        this.phase.set('form');
        return;
      }
    }
    this.phase.set('done');
  }

  private mark(key: Task['key'], state: TaskState, error?: string): void {
    this.tasks.update((list) => list.map((t) => (t.key === key ? { ...t, state, error } : t)));
  }
}
