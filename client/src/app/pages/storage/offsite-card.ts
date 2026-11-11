import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkProgressBar, MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkButtonToggle, MkButtonToggleGroup, MkCheckbox, MkFormField, MkInput, MkPasswordInput } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import type { Dataset, Offsite, OffsiteSchedule, OffsiteSetArgs, OffsiteSnapshot } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { ago, bytes, dateTime } from '../../core/format';
import { ms } from './load';

type Kind = 's3' | 'b2' | 'path';

/**
 * The data itself, off the box: chosen datasets backed up to object storage (S3 or anything that speaks it, Backblaze
 * B2) or to a path, encrypted on the box before they leave. The box makes the repository's password and shows it once
 * here; the storage keys go to the box and never come back.
 */
@Component({
  selector: 'app-offsite-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkTag, MkAlert, MkFormField, MkInput, MkPasswordInput, MkCheckbox, MkButtonToggleGroup, MkButtonToggle, MkIcon, MkProgressBar],
  template: `
    <section class="card">
      <div class="head">
        <h2>Off the box</h2>
        @if (o(); as o) {
          @if (o.repository) {
            <mk-tag size="sm" [tone]="o.lastResult === 'failed' ? 'danger' : o.lastResult === 'ok' ? 'success' : 'neutral'">
              {{ o.running ? 'running' : o.lastResult === 'failed' ? 'last run failed' : o.lastResult === 'ok' ? 'backed up' : 'not run yet' }}
            </mk-tag>
          }
        }
      </div>
      <p class="muted small">
        A copy on another machine needs another machine. This sends the datasets you choose to storage you rent (S3 or anything compatible, Backblaze B2) or
        to a path such as a USB disk, encrypted before anything leaves the box, with a history: seven days, four weeks, twelve months.
      </p>

      @if (error()) {
        <mk-alert tone="danger" title="Could not read the off-site backup" class="alert">{{ error() }}</mk-alert>
      }
      @if (o(); as o) {
        @if (!o.available) {
          <mk-alert tone="info" title="restic is not installed on the box" class="alert">
            It does the encrypting and the sending. On the box: <code>sudo apt install restic</code>, then come back here.
          </mk-alert>
        } @else {
          @if (password(); as p) {
            <mk-alert tone="warning" title="Write this down now — it is shown once" class="alert">
              <p class="small">
                The repository's password. The box keeps it, but the box is what this backup is for losing: without the password nothing in the repository
                can be read, by anyone, ever. Keep it somewhere that is not this box.
              </p>
              <pre class="secret">{{ p }}</pre>
              <button mkButton size="sm" variant="outline" (click)="password.set(null)">I have written it down</button>
            </mk-alert>
          }

          @if (o.repository && !editing()) {
            <dl class="facts">
              <dt>Goes to</dt>
              <dd class="mono">{{ o.repository }}</dd>
              <dt>What</dt>
              <dd>{{ o.datasets.join(', ') }}</dd>
              <dt>When</dt>
              <dd>{{ scheduleLabel(o.schedule) }}</dd>
              @if (!o.hasPassword) {
                <dt>Password</dt>
                <dd class="bad">missing on this box — choose Change and give it again</dd>
              }
            </dl>
            @if (o.running; as j) {
              <div class="running">
                <mk-progress-bar
                  [value]="j.progress ?? 0"
                  [indeterminate]="j.progress === null"
                  size="sm"
                  tone="info"
                  [label]="j.message ?? j.target"
                  [showValue]="j.progress !== null"
                />
                <span class="muted small"
                  >{{ j.total ? f.bytes(j.bytes) + ' of ' + f.bytes(j.total) + ' read, ' : '' }}started {{ f.ago(ms(j.startedAt)) }}</span
                >
              </div>
            } @else if (o.lastRunAt) {
              <p class="last" [class.bad]="o.lastResult === 'failed'">
                <mk-icon [name]="o.lastResult === 'ok' ? 'check' : 'circle-alert'" size="sm" />
                {{ o.lastResult === 'ok' ? 'Last backup' : 'Last backup failed' }} {{ f.ago(ms(o.lastRunAt)) }}{{ o.lastMessage ? ': ' + o.lastMessage : '' }}
              </p>
            } @else {
              <p class="last muted">Never run yet.</p>
            }
            <div class="actions">
              <button mkButton size="sm" [disabled]="!!o.running || !o.hasPassword" [loading]="starting()" (click)="run()">
                <mk-icon name="upload" size="sm" /> Back up now
              </button>
              <button mkButton size="sm" variant="outline" [loading]="listing()" (click)="list()"><mk-icon name="history" size="sm" /> What it holds</button>
              <button mkButton size="sm" variant="ghost" (click)="edit(o)"><mk-icon name="settings" size="sm" /> Change</button>
              <button mkButton size="sm" variant="ghost" tone="danger" [disabled]="!!o.running" (click)="turnOff()">Turn off</button>
            </div>

            @if (snapshots(); as list) {
              @if (list.length === 0) {
                <p class="muted small">The repository holds nothing from this box yet.</p>
              } @else {
                <ul class="snaps">
                  @for (s of list; track s.id) {
                    <li>
                      <span class="mono">{{ s.dataset }}</span>
                      <span class="muted" [title]="s.id">{{ f.dateTime(ms(s.time)) }}</span>
                      <span class="spacer"></span>
                      <button mkButton size="sm" variant="ghost" [disabled]="!!o.running" (click)="restore(s)">
                        <mk-icon name="archive-restore" size="sm" /> Bring back…
                      </button>
                    </li>
                  }
                </ul>
              }
            }
          } @else {
            <form class="form" (submit)="save($event)">
              <mk-button-toggle-group aria-label="Where it goes" [value]="kind()" (valueChange)="kind.set($any($event))">
                <mk-button-toggle value="s3">S3-compatible</mk-button-toggle>
                <mk-button-toggle value="b2">Backblaze B2</mk-button-toggle>
                <mk-button-toggle value="path">A path on the box</mk-button-toggle>
              </mk-button-toggle-group>
              @switch (kind()) {
                @case ('s3') {
                  <mk-form-field label="Bucket address" hint="The endpoint, the bucket and, if you like, a folder in it.">
                    <input mkInput [value]="where()" (input)="where.set($any($event.target).value)" placeholder="https://s3.example.com/my-bucket/nas" autocomplete="off" />
                  </mk-form-field>
                  <div class="row">
                    <mk-form-field label="Access key ID" [hint]="keep() ? 'Empty keeps the stored one.' : ''">
                      <input mkInput [value]="keyId()" (input)="keyId.set($any($event.target).value)" autocomplete="off" />
                    </mk-form-field>
                    <mk-form-field label="Secret access key">
                      <mk-password-input [(value)]="keySecret" autocomplete="off" />
                    </mk-form-field>
                  </div>
                }
                @case ('b2') {
                  <mk-form-field label="Bucket" hint="The bucket's name, and a folder after a colon if you like: my-bucket:nas">
                    <input mkInput [value]="where()" (input)="where.set($any($event.target).value)" placeholder="my-bucket" autocomplete="off" />
                  </mk-form-field>
                  <div class="row">
                    <mk-form-field label="Key ID" [hint]="keep() ? 'Empty keeps the stored one.' : ''">
                      <input mkInput [value]="keyId()" (input)="keyId.set($any($event.target).value)" autocomplete="off" />
                    </mk-form-field>
                    <mk-form-field label="Application key">
                      <mk-password-input [(value)]="keySecret" autocomplete="off" />
                    </mk-form-field>
                  </div>
                }
                @case ('path') {
                  <mk-form-field label="Path" hint="Where another disk is mounted on the box. On the same pool it protects against nothing.">
                    <input mkInput [value]="where()" (input)="where.set($any($event.target).value)" placeholder="/mnt/usb/backup" autocomplete="off" />
                  </mk-form-field>
                }
              }
              <fieldset class="datasets">
                <legend>What goes there</legend>
                @for (d of choices(); track d) {
                  <mk-checkbox [checked]="chosen().has(d)" (checkedChange)="toggle(d, $event)">{{ d }}</mk-checkbox>
                }
                @if (choices().length === 0) {
                  <span class="muted small">No datasets yet.</span>
                }
              </fieldset>
              <mk-button-toggle-group aria-label="How often" [value]="schedule()" (valueChange)="schedule.set($any($event))">
                <mk-button-toggle value="daily">Every day</mk-button-toggle>
                <mk-button-toggle value="weekly">Every week</mk-button-toggle>
                <mk-button-toggle value="manual">Only when asked</mk-button-toggle>
              </mk-button-toggle-group>
              <mk-checkbox [checked]="existing()" (checkedChange)="existing.set($event)">This repository exists already and I have its password</mk-checkbox>
              @if (existing()) {
                <mk-form-field label="Repository password">
                  <mk-password-input [(value)]="repoPassword" autocomplete="off" />
                </mk-form-field>
              } @else if (!keep()) {
                <p class="muted small">A new repository gets a password made on the box. It is shown here once, right after this.</p>
              }
              <div class="actions">
                <button mkButton type="submit" [loading]="saving()" [disabled]="!valid()">{{ o.repository ? 'Save' : 'Set up' }}</button>
                @if (o.repository) {
                  <button mkButton variant="ghost" type="button" (click)="editing.set(false)">Cancel</button>
                }
              </div>
            </form>
          }
        }
      } @else if (!error()) {
        <p class="muted small">Loading…</p>
      }
    </section>
  `,
  styles: [
    `
      .card {
        display: grid;
        gap: var(--mk-space-3);
        padding: var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        margin: var(--mk-space-6) 0;
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
      }
      h2 {
        margin: 0;
        font-size: var(--mk-font-size-lg);
      }
      .small {
        font-size: var(--mk-font-size-sm);
        margin: 0;
      }
      .alert {
        display: block;
      }
      .secret {
        font-family: var(--mk-font-mono);
        font-size: var(--mk-font-size-md);
        user-select: all;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        margin: var(--mk-space-3) 0;
      }
      .facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--mk-space-1) var(--mk-space-4);
        margin: 0;
        font-size: var(--mk-font-size-sm);
      }
      .facts dt {
        color: var(--mk-text-muted);
      }
      .facts dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .mono,
      code {
        font-family: var(--mk-font-mono);
      }
      .running {
        display: grid;
        gap: var(--mk-space-1);
      }
      .last {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        margin: 0;
        font-size: var(--mk-font-size-sm);
      }
      .last mk-icon {
        color: var(--mk-success);
      }
      .bad,
      .bad mk-icon {
        color: var(--mk-danger);
      }
      .actions {
        display: flex;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .snaps {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: var(--mk-space-1);
        font-size: var(--mk-font-size-sm);
      }
      .snaps li {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
      }
      .spacer {
        flex: 1;
      }
      .form {
        display: grid;
        gap: var(--mk-space-3);
        max-width: 40rem;
        justify-items: start;
      }
      .form mk-form-field {
        width: 100%;
      }
      .row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--mk-space-3);
        width: 100%;
      }
      .datasets {
        border: 0;
        padding: 0;
        margin: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .datasets legend {
        padding: 0;
        margin-bottom: var(--mk-space-1);
        font-size: var(--mk-font-size-sm);
        font-weight: 500;
      }
    `,
  ],
})
export class OffsiteCard {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  /** The page's datasets, to choose from. */
  readonly datasets = input<Dataset[]>([]);
  protected readonly f = { ago, bytes, dateTime };
  protected readonly ms = ms;
  protected readonly o = signal<Offsite | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly editing = signal(false);
  protected readonly saving = signal(false);
  protected readonly starting = signal(false);
  protected readonly listing = signal(false);
  protected readonly snapshots = signal<OffsiteSnapshot[] | null>(null);
  /** The password of a repository the box just made: on screen until the person says it is written down. */
  protected readonly password = signal<string | null>(null);

  protected readonly kind = signal<Kind>('s3');
  protected readonly where = signal('');
  protected readonly keyId = signal('');
  protected readonly keySecret = signal('');
  protected readonly chosen = signal<Set<string>>(new Set());
  protected readonly schedule = signal<OffsiteSchedule>('daily');
  protected readonly existing = signal(false);
  protected readonly repoPassword = signal('');

  /** Filesystems below a pool's root, plus whatever is chosen already (it may be unmounted right now). */
  protected readonly choices = computed(() =>
    [...new Set([...this.datasets().filter((d) => d.type === 'filesystem' && d.name.includes('/')).map((d) => d.name), ...this.chosen()])].sort(),
  );
  protected readonly repository = computed(() => {
    const w = this.where().trim();
    return this.kind() === 's3' ? `s3:${w}` : this.kind() === 'b2' ? `b2:${w}` : w;
  });
  /** The stored keys stay usable only while the repository is the one they were stored for. */
  protected readonly keep = computed(() => !!this.o()?.repository && this.o()?.repository === this.repository() && (this.o()?.hasPassword ?? false));
  protected readonly valid = computed(() => {
    if (!this.where().trim() || this.chosen().size === 0) return false;
    if (this.existing() && this.repoPassword().length < 12) return false;
    if (this.kind() === 'path' || this.keep()) return true;
    return !!this.keyId().trim() && !!this.keySecret();
  });

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.timer && clearTimeout(this.timer));
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.show(await this.api.nas.offsite());
    } catch (e) {
      // an agent before 0.10.0 has no such verb: the card says so instead of pretending to be empty
      this.error.set(errorMessage(e));
    }
  }

  /** While something runs the card follows it; when it ends the list of what the repository holds is stale. */
  private show(o: Offsite): void {
    const was = this.o()?.running;
    this.o.set(o);
    this.error.set(null);
    if (was && !o.running) this.snapshots.set(null);
    if (this.timer) clearTimeout(this.timer);
    if (o.running) this.timer = setTimeout(() => void this.load(), 3000);
  }

  protected scheduleLabel(s: OffsiteSchedule): string {
    return s === 'daily' ? 'every day' : s === 'weekly' ? 'every week' : 'only when asked';
  }

  protected toggle(dataset: string, on: boolean): void {
    const next = new Set(this.chosen());
    if (on) next.add(dataset);
    else next.delete(dataset);
    this.chosen.set(next);
  }

  protected edit(o: Offsite): void {
    const r = o.repository ?? '';
    this.kind.set(r.startsWith('s3:') ? 's3' : r.startsWith('b2:') ? 'b2' : 'path');
    this.where.set(r.replace(/^(s3|b2):/, ''));
    this.keyId.set('');
    this.keySecret.set('');
    this.chosen.set(new Set(o.datasets));
    this.schedule.set(o.schedule);
    this.existing.set(false);
    this.repoPassword.set('');
    this.editing.set(true);
  }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.valid()) return;
    const args: OffsiteSetArgs = { repository: this.repository(), datasets: [...this.chosen()], schedule: this.schedule() };
    const id = this.keyId().trim();
    const secret = this.keySecret();
    if (this.kind() !== 'path' && (id || secret)) {
      args.credentials = {};
      const [idName, secretName] = this.kind() === 's3' ? ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] : ['B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY'];
      if (id) args.credentials[idName] = id;
      if (secret) args.credentials[secretName] = secret;
    }
    if (this.existing()) args.password = this.repoPassword();
    this.saving.set(true);
    try {
      const o = await this.api.nas.setOffsite(args);
      const { password, ...rest } = o;
      this.show(rest);
      this.password.set(password ?? null);
      this.keySecret.set('');
      this.repoPassword.set('');
      this.editing.set(false);
      this.toast.success(password ? 'The repository was made — write its password down' : 'Saved');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  async run(): Promise<void> {
    this.starting.set(true);
    try {
      await this.api.nas.runOffsite();
      await this.load();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.starting.set(false);
    }
  }

  async list(): Promise<void> {
    this.listing.set(true);
    try {
      this.snapshots.set(await this.api.nas.offsiteSnapshots());
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.listing.set(false);
    }
  }

  async restore(s: OffsiteSnapshot): Promise<void> {
    const ok = await this.dialog.confirm({
      title: `Bring back ${s.dataset} as of ${dateTime(ms(s.time))}?`,
      message: `It is downloaded into a new folder, restored-<date>, at the top of ${s.dataset}. Nothing that is there now is changed; move what you need out of that folder afterwards. The dataset needs room for it.`,
      confirmText: 'Bring back',
    });
    if (!ok) return;
    try {
      await this.api.nas.restoreOffsite(s.id, s.dataset);
      this.toast.success('Started — this card follows it');
      await this.load();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async turnOff(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Stop backing up off the box?',
      message: 'The box forgets the repository, its keys and its password. What is stored there stays, and stays readable only with the password.',
      confirmText: 'Turn off',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      this.show(await this.api.nas.removeOffsite());
      this.snapshots.set(null);
      this.password.set(null);
      this.editing.set(false);
      this.toast.success('Turned off');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
