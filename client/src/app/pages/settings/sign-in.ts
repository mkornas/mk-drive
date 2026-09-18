import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkCard, MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkButtonToggle, MkButtonToggleGroup, MkFormField, MkInput, MkPasswordInput } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import type { PasswordLoginMode, SsoSettings } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { SettingsShell } from './shell';

/**
 * Single sign-on for this drive: the admin brings their own OpenID Connect provider (Pocket ID, Authentik, Keycloak, …).
 * Nothing ships configured; the provider is checked before anything is saved, and the secret is never shown again.
 * Below it, where password sign-in works: everywhere, only on the local network, or nowhere.
 */
@Component({
  selector: 'app-sign-in-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkCard, MkAlert, MkFormField, MkInput, MkPasswordInput, MkIcon, MkTag, MkButtonToggleGroup, MkButtonToggle],
  template: `
    <app-settings heading="Sign-in" description="Let people sign in with your own identity provider, next to their password.">
      @if (s(); as s) {
        <mk-card class="block">
          <div class="status">
            <h2>Single sign-on</h2>
            @if (!s.source) {
              <mk-tag size="sm" tone="neutral">off</mk-tag>
            } @else if (s.ready) {
              <mk-tag size="sm" tone="success">on · {{ s.name }}</mk-tag>
            } @else {
              <mk-tag size="sm" tone="warning">on · not reachable</mk-tag>
            }
          </div>
          <p class="muted">
            Any OpenID Connect provider works: Pocket ID, Authentik, Authelia, Keycloak, Google. The provider says who someone is; only emails that have an
            account on this drive get in, so add people first.
          </p>
          @if (s.source && !s.ready && s.error) {
            <mk-alert tone="warning" title="The provider did not answer" class="alert">{{ s.error }}</mk-alert>
          }
          @if (s.source === 'env') {
            <mk-alert tone="info" title="Set by the drive's environment" class="alert">
              DRIVE_OIDC_ISSUER, DRIVE_OIDC_CLIENT_ID and DRIVE_OIDC_CLIENT_SECRET configure it, so it is read-only here. Remove those lines from the .env and
              restart the drive to manage it on this page.
            </mk-alert>
          }

          <h3>1. Register the drive at your provider</h3>
          <p class="muted small">Create an OIDC client (confidential, with a secret) and give it these addresses:</p>
          <dl class="uris">
            <dt>Redirect URI</dt>
            <dd>
              <code>{{ s.redirectUri }}</code>
              <button mkButton variant="ghost" size="sm" iconOnly aria-label="Copy the redirect URI" (click)="copy(s.redirectUri)">
                <mk-icon name="copy" size="sm" />
              </button>
            </dd>
            <dt>Logout redirect</dt>
            <dd>
              <code>{{ s.logoutRedirectUri }}</code>
              <button mkButton variant="ghost" size="sm" iconOnly aria-label="Copy the logout redirect" (click)="copy(s.logoutRedirectUri)">
                <mk-icon name="copy" size="sm" />
              </button>
            </dd>
          </dl>
          <p class="muted small">
            These follow the address this page is open on. Open it from the address people use (for example your public https name) before you copy them.
          </p>

          <h3>2. Tell the drive about it</h3>
          <form class="form" (submit)="save($event)">
            <mk-form-field label="Button name" hint="The sign-in page says “Sign in with …”.">
              <input mkInput [value]="name()" (input)="name.set($any($event.target).value)" placeholder="Single sign-on" maxlength="40" [disabled]="locked()" />
            </mk-form-field>
            <mk-form-field label="Issuer URL" hint="The provider's base address; its /.well-known/openid-configuration must answer.">
              <input
                mkInput
                type="url"
                [value]="issuer()"
                (input)="issuer.set($any($event.target).value)"
                placeholder="https://id.example.com"
                required
                [disabled]="locked()"
              />
            </mk-form-field>
            <mk-form-field label="Client ID">
              <input mkInput [value]="clientId()" (input)="clientId.set($any($event.target).value)" required [disabled]="locked()" autocomplete="off" />
            </mk-form-field>
            <mk-form-field
              label="Client secret"
              [hint]="s.hasSecret ? 'Saved. Leave empty to keep it.' : 'Shown once by the provider; it is not shown here again.'"
            >
              <mk-password-input [(value)]="secret" autocomplete="new-password" [disabled]="locked()" />
            </mk-form-field>
            @if (s.passwordLoginOff) {
              <mk-alert tone="warning" title="Password sign-in is off on this drive" class="alert">
                Single sign-on is the only way in. A wrong client ID or secret locks everyone out until password sign-in is turned back on (below, or
                DRIVE_PASSWORD_LOGIN).
              </mk-alert>
            }
            @if (!locked()) {
              <div class="actions">
                <button mkButton type="submit" [loading]="saving()" [disabled]="!canSave()">{{ s.source ? 'Save' : 'Check and turn on' }}</button>
                @if (s.source === 'settings') {
                  <button mkButton variant="ghost" tone="danger" type="button" [loading]="removing()" [disabled]="s.passwordLoginOff" (click)="turnOff()">
                    Turn off
                  </button>
                }
              </div>
            }
          </form>
        </mk-card>

        <mk-card class="block">
          <h2>Password sign-in</h2>
          <p class="muted">
            Email and password on the sign-in page, and the iOS app's first sign-in. App passwords (Settings → Devices) work from anywhere, whatever is chosen
            here.
          </p>
          @if (s.passwordLoginSource === 'env') {
            <mk-alert tone="info" title="Set by the drive's environment" class="alert">
              DRIVE_PASSWORD_LOGIN={{ s.passwordLogin }} configures it, so it is read-only here. Remove that line from the .env and restart the drive to choose
              it on this page.
            </mk-alert>
          }
          <mk-button-toggle-group
            class="modes"
            aria-label="Where password sign-in works"
            [value]="mode()"
            (valueChange)="setMode($any($event))"
            [disabled]="modeLocked() || settingMode()"
          >
            <mk-button-toggle value="on">Everywhere</mk-button-toggle>
            <mk-button-toggle value="local">Local network only</mk-button-toggle>
            <mk-button-toggle value="off" [disabled]="!s.source && mode() !== 'off'">Off</mk-button-toggle>
          </mk-button-toggle-group>
          <p class="muted small">
            @switch (mode()) {
              @case ('on') {
                Anyone who reaches the drive, at home or from the internet, gets the password form.
                @if (s.source) {
                  From the internet that form can be held shut: wrong passwords for an address pause its sign-in for up to half a minute, so someone who knows
                  the address can keep it paused (single sign-on is not affected). With single sign-on on, <em>Local network only</em> avoids that.
                }
              }
              @case ('local') {
                Only from this network (private and loopback addresses). From the internet, a Cloudflare Tunnel included, the sign-in page offers single sign-on
                alone; the iOS app signs in there with an app password. Sessions already open keep working.
              }
              @case ('off') {
                Nobody signs in with a password; single sign-on is the only way in.
              }
            }
          </p>
          @if (!s.source && mode() !== 'off' && s.passwordLoginSource !== 'env') {
            <p class="muted small">Off needs single sign-on turned on first, or nobody could sign in.</p>
          }
        </mk-card>
      } @else if (error()) {
        <mk-alert tone="danger" title="Could not load the sign-in settings">{{ error() }}</mk-alert>
      } @else {
        <p class="muted">Loading…</p>
      }
    </app-settings>
  `,
  styles: [
    `
      .block {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
      .status {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
      }
      h2 {
        margin: 0;
        font-size: var(--mk-font-size-lg);
      }
      h3 {
        margin: var(--mk-space-5) 0 var(--mk-space-1);
        font-size: var(--mk-font-size-md);
      }
      .alert {
        display: block;
        margin: var(--mk-space-3) 0;
      }
      .small {
        font-size: var(--mk-font-size-sm);
      }
      .uris {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--mk-space-1) var(--mk-space-3);
        align-items: center;
        margin: var(--mk-space-2) 0;
      }
      .uris dt {
        color: var(--mk-text-muted);
        font-size: var(--mk-font-size-sm);
      }
      .uris dd {
        margin: 0;
        display: flex;
        align-items: center;
        gap: var(--mk-space-1);
        min-width: 0;
      }
      code {
        font-family: var(--mk-font-mono);
        font-size: var(--mk-font-size-sm);
        overflow-wrap: anywhere;
        user-select: all;
      }
      .form {
        display: grid;
        gap: var(--mk-space-3);
        max-width: 32rem;
        margin-top: var(--mk-space-3);
      }
      .modes {
        margin: var(--mk-space-3) 0 var(--mk-space-2);
      }
      .actions {
        display: flex;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
    `,
  ],
})
export class SignInSettingsPage {
  private readonly api = inject(ApiService);
  private readonly drive = inject(DriveService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly s = signal<SsoSettings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly issuer = signal('');
  protected readonly clientId = signal('');
  protected readonly secret = signal('');
  protected readonly saving = signal(false);
  protected readonly removing = signal(false);
  protected readonly mode = signal<PasswordLoginMode>('on');
  protected readonly settingMode = signal(false);
  protected readonly modeLocked = computed(() => this.s()?.passwordLoginSource === 'env' || !!this.drive.meta()?.demo);
  protected readonly locked = computed(() => this.s()?.source === 'env' || !!this.drive.meta()?.demo);
  protected readonly canSave = computed(() => !!this.issuer().trim() && !!this.clientId().trim() && (!!this.secret() || !!this.s()?.hasSecret));

  constructor() {
    void this.load();
  }

  private fill(s: SsoSettings): void {
    this.s.set(s);
    this.mode.set(s.passwordLogin);
    this.name.set(s.source || s.name !== 'Single sign-on' ? s.name : '');
    this.issuer.set(s.issuer);
    this.clientId.set(s.clientId);
    this.secret.set('');
  }

  async load(): Promise<void> {
    try {
      this.fill(await this.api.ssoSettings());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.canSave()) return;
    this.saving.set(true);
    try {
      const s = await this.api.setSsoSettings({
        name: this.name().trim(),
        issuer: this.issuer().trim(),
        clientId: this.clientId().trim(),
        clientSecret: this.secret(),
      });
      this.fill(s);
      await this.drive.ready();
      this.toast.success(`Single sign-on is on: the sign-in page offers “Sign in with ${s.name}”`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  async turnOff(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Turn off single sign-on?',
      message: 'The sign-in page stops offering it and the saved client secret is deleted. Everyone signs in with their password; sessions already open stay.',
      confirmText: 'Turn off',
      tone: 'danger',
    });
    if (!ok) return;
    this.removing.set(true);
    try {
      this.fill(await this.api.removeSsoSettings());
      this.toast.success('Single sign-on is off');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.removing.set(false);
    }
  }

  async setMode(mode: PasswordLoginMode): Promise<void> {
    const before = this.mode();
    if (mode === before) return;
    this.mode.set(mode);
    this.settingMode.set(true);
    try {
      this.fill(await this.api.setPasswordLogin(mode));
      await this.drive.ready();
      this.toast.success(
        mode === 'on' ? 'Password sign-in works everywhere' : mode === 'local' ? 'Password sign-in works only on the local network' : 'Password sign-in is off',
      );
    } catch (e) {
      this.mode.set(before);
      this.toast.danger(errorMessage(e));
    } finally {
      this.settingMode.set(false);
    }
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success('Copied');
    } catch {
      this.toast.warning('Could not copy — select it and copy by hand');
    }
  }
}
