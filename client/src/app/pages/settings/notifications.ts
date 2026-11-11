import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkCard, MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkButtonToggle, MkButtonToggleGroup, MkFormField, MkInput, MkSwitch } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkSpinner } from '@mk-kit/ui/status';
import type { Heartbeat, NotifySeverity, PushDevice } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { PushService } from '../../core/push.service';
import { ago, dateTime } from '../../core/format';
import { ms } from '../storage/load';
import { SettingsShell } from './shell';

/**
 * Notifications for this account: whether this browser gets them, which of the
 * account's browsers are registered, and how loud something has to be. Works
 * without a NAS (there is simply nothing to send yet) and says plainly when
 * the browser itself cannot do push.
 */
@Component({
  selector: 'app-notifications-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkCard, MkTag, MkAlert, MkSwitch, MkFormField, MkInput, MkButtonToggleGroup, MkButtonToggle, MkIcon, MkSpinner],
  template: `
    <app-settings heading="Notifications" description="Have this drive wake you when something needs you, on the browsers you choose.">
      @if (push.settings(); as s) {
        <mk-card class="block">
          <h2>This browser</h2>
          @if (push.blocker(); as why) {
            <mk-alert tone="info" title="Not here" class="alert">{{ why }}</mk-alert>
          } @else if (!s.supported) {
            <mk-alert tone="warning" title="This drive cannot send notifications yet" class="alert">
              The drive makes its signing keys on the next start; once it has them this switch works.
            </mk-alert>
          } @else {
            <label class="row">
              <mk-switch [checked]="push.subscribed()" [disabled]="push.busy()" (checkedChange)="toggle()" aria-label="Notify this browser" />
              <span class="row__text">
                <span class="row__title">{{ push.subscribed() ? 'This browser is notified' : 'Notify this browser' }}</span>
                <span class="muted small">
                  {{
                    push.subscribed()
                      ? 'It shows a notification even when the drive is not open, as long as the browser is running.'
                      : 'The browser asks first; you can take it back here at any time.'
                  }}
                </span>
              </span>
            </label>
            @if (push.permission() === 'denied') {
              <mk-alert tone="warning" title="Blocked in the browser" class="alert">
                Notifications for this site are turned off in the browser’s own settings. Allow them there, then try again.
              </mk-alert>
            }
            <div class="actions">
              <button mkButton variant="outline" size="sm" [loading]="testing()" [disabled]="!s.devices.length" (click)="sendTest()">
                <mk-icon name="bell" size="sm" /> Send a test
              </button>
              @if (!s.devices.length) {
                <span class="muted small">Turn it on somewhere first — a test goes to the browsers below.</span>
              }
            </div>
          }
          @if (push.error(); as e) {
            <mk-alert tone="danger" title="That did not work" class="alert">{{ e }}</mk-alert>
          }
        </mk-card>

        <mk-card class="block">
          <h2>Where notifications go</h2>
          @if (!s.devices.length) {
            <p class="muted">No browser is set up yet.</p>
          } @else {
            <ul class="list">
              @for (d of s.devices; track d.id) {
                <li class="item" [class.item--current]="d.current">
                  <mk-icon name="bell" class="item__icon" />
                  <div class="item__main">
                    <div class="item__title">
                      {{ d.name }}
                      @if (d.current) {
                        <mk-tag size="sm" tone="primary">this browser</mk-tag>
                      }
                    </div>
                    <div class="muted item__meta">
                      {{ d.lastSentAt ? 'last sent ' + f.ago(ms(d.lastSentAt)) : 'nothing sent yet' }} · added {{ f.dateTime(ms(d.addedAt)) }}
                    </div>
                  </div>
                  <button mkButton variant="ghost" size="sm" tone="danger" (click)="forget(d)">Forget</button>
                </li>
              }
            </ul>
          }
        </mk-card>

        <mk-card class="block">
          <h2>What is worth a notification</h2>
          <mk-button-toggle-group
            class="modes"
            aria-label="How loud something has to be"
            [value]="severity()"
            [disabled]="saving()"
            (valueChange)="setSeverity($any($event))"
          >
            <mk-button-toggle value="critical">Critical only</mk-button-toggle>
            <mk-button-toggle value="warning">Warnings too</mk-button-toggle>
            <mk-button-toggle value="info">Everything</mk-button-toggle>
          </mk-button-toggle-group>
          <p class="muted small">
            @switch (severity()) {
              @case ('critical') {
                Only what needs someone today: a pool that lost redundancy, a disk that is failing, a filesystem that is full.
              }
              @case ('warning') {
                The above, plus what needs someone soon: a pool filling up, a disk with growing reallocations, a copy that keeps failing.
              }
              @case ('info') {
                Everything the box raises, down to the ones that are merely worth knowing.
              }
            }
          </p>
          @if (drive.isAdmin()) {
            <label class="row">
              <mk-switch [checked]="nasAlerts()" [disabled]="saving()" (checkedChange)="setNasAlerts($any($event))" aria-label="Notify about NAS alerts" />
              <span class="row__text">
                <span class="row__title">NAS alerts</span>
                <span class="muted small">
                  @if (drive.meta()?.nas) {
                    What the box says is wrong, and a note when it is over. This is all the drive has to send for now.
                  } @else {
                    This drive has no NAS attached, so nothing is sent yet; the choice is kept for when one is.
                  }
                </span>
              </span>
            </label>
            @if (severity() !== 'info') {
              <label class="row row--next">
                <mk-switch [checked]="digest()" [disabled]="saving() || !nasAlerts()" (checkedChange)="setDigest($any($event))" aria-label="A weekly summary of the quiet ones" />
                <span class="row__text">
                  <span class="row__title">A weekly summary of the rest</span>
                  <span class="muted small">
                    What is open but too quiet for a notification of its own — a newer release, a dataset without snapshots — once a week, as one
                    notification. Nothing is sent in a week with nothing to say.
                  </span>
                </span>
              </label>
            }
          }
        </mk-card>

        @if (drive.isAdmin()) {
          <mk-card class="block">
            <h2>When the drive itself goes quiet</h2>
            <p class="muted small lead">
              Everything above is sent by this drive, so it cannot tell you that it is off: no power, a hung box, no network. Give it the address of
              a check somewhere else (healthchecks.io, an Uptime Kuma push monitor, a script on another machine) and it fetches that address every
              {{ beat()?.everyMinutes ?? 5 }} minutes. The other side is what tells you when the requests stop.
            </p>
            <mk-form-field label="Address to fetch" hint="Empty turns it off. Only the request itself is sent, nothing about the drive.">
              <input
                mkInput
                type="url"
                inputmode="url"
                autocomplete="off"
                placeholder="https://…"
                [value]="beatUrl()"
                (input)="beatUrl.set($any($event.target).value)"
                (keydown.enter)="saveBeat()"
              />
            </mk-form-field>
            <div class="actions">
              <button mkButton size="sm" [loading]="beatSaving()" [disabled]="beatUrl().trim() === (beat()?.url ?? '')" (click)="saveBeat()">Save and try it</button>
              @if (beat(); as b) {
                @if (b.url && b.lastAt) {
                  <mk-tag size="sm" [tone]="b.lastOk ? 'success' : 'danger'">{{ b.lastOk ? 'answered' : 'no answer' }}</mk-tag>
                  <span class="muted small">{{ f.ago(ms(b.lastAt)) }}{{ b.lastOk ? '' : ' — ' + b.lastError }}</span>
                } @else if (!b.url) {
                  <span class="muted small">Off.</span>
                }
              }
            </div>
          </mk-card>
        }
      } @else if (push.error()) {
        <mk-alert tone="danger" title="Could not load your notification settings">{{ push.error() }}</mk-alert>
      } @else {
        <mk-spinner />
      }
    </app-settings>
  `,
  styles: [
    `
      .block {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
      h2 {
        margin: 0 0 var(--mk-space-3);
        font-size: var(--mk-font-size-lg);
      }
      .alert {
        display: block;
        margin: var(--mk-space-3) 0;
      }
      .small {
        font-size: var(--mk-font-size-sm);
      }
      .row {
        display: flex;
        align-items: flex-start;
        gap: var(--mk-space-3);
        cursor: pointer;
      }
      .row__text {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .row__title {
        font-weight: 500;
      }
      .row--next {
        margin-top: var(--mk-space-4);
      }
      /* its text is long: it takes the rest of the line instead of wrapping under the switch */
      .row--next .row__text {
        flex: 1;
      }
      .lead {
        margin: 0 0 var(--mk-space-4);
        max-width: 70ch;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--mk-space-2) var(--mk-space-3);
        margin-top: var(--mk-space-4);
      }
      .list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: var(--mk-space-2);
      }
      .item {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        padding: var(--mk-space-3) var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
      }
      .item--current {
        border-color: var(--mk-primary);
      }
      .item__icon {
        color: var(--mk-text-muted);
      }
      .item__main {
        flex: 1;
        min-width: 0;
      }
      .item__title {
        font-weight: 500;
        display: flex;
        gap: var(--mk-space-2);
        align-items: center;
        flex-wrap: wrap;
      }
      .item__meta {
        font-size: var(--mk-font-size-sm);
        overflow-wrap: anywhere;
      }
      .modes {
        margin-bottom: var(--mk-space-2);
      }
      .modes + p {
        margin: 0 0 var(--mk-space-4);
        max-width: 60ch;
      }
    `,
  ],
})
export class NotificationsPage {
  protected readonly push = inject(PushService);
  protected readonly drive = inject(DriveService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  protected readonly f = { ago, dateTime };
  protected readonly ms = ms;

  protected readonly severity = computed<NotifySeverity>(() => this.push.settings()?.minSeverity ?? 'warning');
  protected readonly nasAlerts = computed(() => this.push.settings()?.nasAlerts ?? false);
  protected readonly digest = computed(() => this.push.settings()?.digest ?? false);
  private readonly api = inject(ApiService);
  protected readonly beat = signal<Heartbeat | null>(null);
  protected readonly beatUrl = signal('');
  protected readonly beatSaving = signal(false);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    await this.drive.ready();
    await this.push.refresh();
    if (!this.drive.isAdmin()) return;
    try {
      const b = await this.api.heartbeat.get();
      this.beat.set(b);
      this.beatUrl.set(b.url ?? '');
    } catch {
      /* the card stays empty; saving says what is wrong */
    }
  }

  async saveBeat(): Promise<void> {
    this.beatSaving.set(true);
    try {
      const b = await this.api.heartbeat.set(this.beatUrl().trim());
      this.beat.set(b);
      this.beatUrl.set(b.url ?? '');
      if (!b.url) this.toast.success('Turned off');
      else if (b.lastOk) this.toast.success('Saved — the other side answered');
      else this.toast.warning(`Saved, but the address did not answer: ${b.lastError}`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.beatSaving.set(false);
    }
  }

  async toggle(): Promise<void> {
    const on = await this.push.toggle();
    const failed = this.push.error();
    if (failed) this.toast.danger(failed);
    else this.toast.success(on ? 'This browser will be notified' : 'This browser will not be notified');
  }

  async sendTest(): Promise<void> {
    this.testing.set(true);
    try {
      const sent = await this.push.test();
      if (sent === null) this.toast.danger(this.push.error() ?? 'The test could not be sent');
      else if (sent === 0) this.toast.warning('Nothing to send to — no browser is set up yet');
      else this.toast.success(sent === 1 ? 'A test notification is on its way' : `A test notification went to ${sent} browsers`);
    } finally {
      this.testing.set(false);
    }
  }

  async forget(d: PushDevice): Promise<void> {
    const ok = await this.dialog.confirm({
      title: `Forget “${d.name}”?`,
      message: d.current
        ? 'This browser stops being notified; you can turn it back on here.'
        : 'That browser stops being notified until it is turned on there again.',
      confirmText: 'Forget',
      tone: 'danger',
    });
    if (!ok) return;
    // this browser's own row goes through the subscription, so the browser lets go too
    if (d.current) await this.push.disable();
    else await this.push.forget(d.id);
    const failed = this.push.error();
    if (failed) this.toast.danger(failed);
    else this.toast.success('Forgotten');
  }

  async setSeverity(minSeverity: NotifySeverity): Promise<void> {
    if (minSeverity === this.severity()) return;
    await this.save({ minSeverity });
  }

  async setNasAlerts(nasAlerts: boolean): Promise<void> {
    if (nasAlerts === this.nasAlerts()) return;
    await this.save({ nasAlerts });
  }

  async setDigest(digest: boolean): Promise<void> {
    if (digest === this.digest()) return;
    await this.save({ digest });
  }

  private async save(input: { minSeverity?: NotifySeverity; nasAlerts?: boolean; digest?: boolean }): Promise<void> {
    this.saving.set(true);
    try {
      if (await this.push.save(input)) this.toast.success('Saved');
      else this.toast.danger(this.push.error() ?? 'Could not save that');
    } finally {
      this.saving.set(false);
    }
  }
}
