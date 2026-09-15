import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTag } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import { MkInput } from '@mk-kit/ui/forms';
import type { AppPassword, AppPasswordCreated, Session } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { ago, dateTime } from '../../core/format';
import { SettingsShell } from './shell';

/** "Chrome on Linux" out of a user-agent string; good enough to recognise a device. */
export function describeAgent(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/.test(ua) ? 'curl' : '';
  if (!os && !browser) return ua ? ua.slice(0, 40) : 'Unknown device';
  return [browser, os].filter(Boolean).join(' on ');
}

@Component({
  selector: 'app-devices',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkIcon, MkTag, MkEmptyState, MkSpinner, MkInput],
  template: `
    <app-settings heading="Devices" description="Everywhere you are signed in. Signing a device out takes effect immediately.">
      @if (drive.me()?.via === 'access') {
        <mk-empty-state icon="shield-check" title="Signed in through Cloudflare Access" description="Sessions are managed by Access, not here." />
      } @else if (sessions() === null) {
        <mk-spinner />
      } @else if (sessions()!.length === 0) {
        <mk-empty-state icon="smartphone" title="No sessions" />
      } @else {
        <ul class="list">
          @for (s of sessions(); track s.id) {
            <li class="item" [class.item--current]="s.current">
              <mk-icon [name]="icon(s.userAgent)" class="item__icon" />
              <div class="item__main">
                <div class="item__title">{{ agent(s.userAgent) }} @if (s.current) {<mk-tag size="sm" tone="primary">this device</mk-tag>}</div>
                <div class="muted item__meta">{{ s.ip }} · active {{ f.ago(s.lastSeenAt) }} · signed in {{ f.dateTime(s.createdAt) }}</div>
              </div>
              @if (!s.current) {
                <button mkButton variant="ghost" size="sm" (click)="revoke(s)">Sign out</button>
              }
            </li>
          }
        </ul>
        @if (sessions()!.length > 1) {
          <button mkButton variant="outline" tone="danger" (click)="revokeOthers()">Sign out every other device</button>
        }
      }

      @if (drive.me()?.via === 'session') {
        <section class="tokens">
          <h2>App passwords</h2>
          <p class="muted">For programs that cannot sign in with a browser: <code>curl</code>, scripts, WebDAV. Each one is a long random secret with the same access as you, shown once; remove it here when the program is gone.</p>
          <p class="muted">To mount the drive on a computer or a phone, <a href="/settings/connect">Connect</a> has the steps for each system with the address filled in.</p>
          @if (made(); as t) {
            <div class="made">
              <div class="made__title"><mk-icon name="key" size="sm" /> “{{ t.name }}” is ready — copy it now, it will not be shown again</div>
              <div class="made__row">
                <input mkInput readonly [value]="t.secret" (focus)="$any($event.target).select()" aria-label="App password" class="mono" />
                <button mkButton (click)="copy(t.secret)"><mk-icon name="copy" size="sm" /> Copy</button>
              </div>
              <pre class="made__hint muted">curl -u {{ drive.me()?.email }}:{{ t.secret }} {{ origin }}/api/ls?path=…</pre>
              <button mkButton variant="ghost" size="sm" (click)="made.set(null)">Done</button>
            </div>
          } @else {
            <form class="new" (submit)="create($event)">
              <input mkInput [value]="name()" (input)="name.set($any($event.target).value)" placeholder="What will use it, e.g. “Finder on the MacBook”" aria-label="Name" maxlength="60" />
              <button mkButton type="submit" [loading]="creating()" [disabled]="!name().trim()"><mk-icon name="key" size="sm" /> Make one</button>
            </form>
          }
          @if (tokens(); as list) {
            @if (list.length) {
              <ul class="list">
                @for (t of list; track t.id) {
                  <li class="item">
                    <mk-icon name="key" class="item__icon" />
                    <div class="item__main">
                      <div class="item__title">{{ t.name }} <span class="mono muted small">{{ t.prefix }}…</span></div>
                      <div class="muted item__meta">{{ t.lastUsedAt ? 'last used ' + f.ago(t.lastUsedAt) + (t.lastIp ? ' from ' + t.lastIp : '') : 'never used' }} · made {{ f.dateTime(t.createdAt) }}</div>
                    </div>
                    <button mkButton variant="ghost" size="sm" tone="danger" (click)="revokeToken(t)">Remove</button>
                  </li>
                }
              </ul>
            }
          }
        </section>
      }
    </app-settings>
  `,
  styles: [
    `
      .list {
        list-style: none;
        padding: 0;
        margin: 0 0 var(--mk-space-4);
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
      }
      .tokens {
        margin-top: var(--mk-space-8);
      }
      .tokens h2 {
        font-size: var(--mk-font-size-lg);
        margin: 0 0 var(--mk-space-2);
      }
      .tokens p {
        margin: 0 0 var(--mk-space-4);
      }
      .new,
      .made__row {
        display: flex;
        gap: var(--mk-space-2);
        margin-bottom: var(--mk-space-4);
      }
      .new input,
      .made__row input {
        flex: 1;
        min-width: 0;
      }
      .made {
        padding: var(--mk-space-4);
        border: 1px solid var(--mk-primary);
        border-radius: var(--mk-radius-lg);
        margin-bottom: var(--mk-space-4);
      }
      .made__title {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        font-weight: 500;
        margin-bottom: var(--mk-space-3);
      }
      .made__hint {
        font-size: var(--mk-font-size-xs);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: 0 0 var(--mk-space-3);
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class DevicesPage {
  protected readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly sessions = signal<Session[] | null>(null);
  protected readonly tokens = signal<AppPassword[] | null>(null);
  protected readonly name = signal('');
  protected readonly creating = signal(false);
  /** The app password just made, secret included, until the user is done with it. */
  protected readonly made = signal<AppPasswordCreated | null>(null);
  protected readonly origin = location.origin;
  protected readonly f = { ago, dateTime };
  protected readonly agent = describeAgent;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    await this.drive.ready();
    if (this.drive.me()?.via === 'session') {
      this.sessions.set(await this.api.sessions());
      this.tokens.set(await this.api.appPasswords().catch(() => []));
    } else this.sessions.set([]);
  }

  async create(ev: Event): Promise<void> {
    ev.preventDefault();
    this.creating.set(true);
    try {
      const t = await this.api.createAppPassword(this.name().trim());
      this.made.set(t);
      this.name.set('');
      this.tokens.update((l) => [t, ...(l ?? [])]);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.creating.set(false);
    }
  }

  async copy(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      this.toast.success('Copied');
    } catch {
      this.toast.warning('Could not copy — select it and copy by hand');
    }
  }

  async revokeToken(t: AppPassword): Promise<void> {
    if (!(await this.dialog.confirm({ title: `Remove “${t.name}”?`, message: 'Whatever uses it stops working right away.', confirmText: 'Remove', tone: 'danger' }))) return;
    try {
      await this.api.revokeAppPassword(t.id);
      this.tokens.update((l) => l?.filter((x) => x.id !== t.id) ?? null);
      if (this.made()?.id === t.id) this.made.set(null);
      this.toast.success('App password removed');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  icon(ua: string): string {
    return /iPhone|Android/.test(ua) ? 'smartphone' : /iPad|Tablet/.test(ua) ? 'tablet' : 'laptop';
  }

  async revoke(s: Session): Promise<void> {
    try {
      await this.api.revokeSession(s.id);
      this.sessions.update((list) => list?.filter((x) => x.id !== s.id) ?? null);
      this.toast.success('Signed out on that device');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async revokeOthers(): Promise<void> {
    if (!(await this.dialog.confirm({ title: 'Sign out every other device?', message: 'Only this browser stays signed in.', confirmText: 'Sign out others', tone: 'danger' }))) return;
    try {
      await this.api.revokeOtherSessions();
      this.sessions.update((list) => list?.filter((x) => x.current) ?? null);
      this.toast.success('Signed out everywhere else');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
