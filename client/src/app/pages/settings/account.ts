import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkFormField, MkInput, MkPasswordInput } from '@mk-kit/ui/forms';
import { MkToastService } from '@mk-kit/ui/feedback';
import { MkCard, MkDescItem, MkDescriptionList } from '@mk-kit/ui/data';
import { MK_ACCENT_ORDER, MK_ACCENTS, MkAccentService, mkAccentSwatch, MkThemeService, type MkAccentKey, type MkThemePreference } from '@mk-kit/ui/core';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { SettingsShell } from './shell';

@Component({
  selector: 'app-account',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkFormField, MkInput, MkPasswordInput, MkCard, MkDescriptionList, MkDescItem],
  template: `
    <app-settings heading="Account" description="Who you are on this drive.">
      <mk-card class="block">
        <mk-description-list layout="grid">
          <mk-desc-item term="Email">{{ drive.me()?.email }}</mk-desc-item>
          <mk-desc-item term="Role">{{ drive.me()?.role === 'admin' ? 'Admin — manages people and sees every location' : 'Member' }}</mk-desc-item>
          <mk-desc-item term="Signed in via">{{ drive.me()?.via === 'access' ? 'Cloudflare Access' : 'password' }}</mk-desc-item>
        </mk-description-list>
      </mk-card>

      @if (drive.meta()?.demo) {
        <p class="muted demo-note">This is the demo drive: the account, its name and password are fixed, and everything is reset every night.</p>
      }
      <mk-card class="block">
        <h2>Appearance</h2>
        <p class="muted">Yours on this browser; the drive itself does not change for anyone else.</p>
        <div class="look">
          <span class="look__label">Theme</span>
          <div class="look__choices" role="group" aria-label="Theme">
            @for (t of themes; track t.value) {
              <button mkButton [variant]="theme.preference() === t.value ? 'solid' : 'outline'" size="sm" type="button" (click)="theme.setTheme(t.value)">
                {{ t.label }}
              </button>
            }
          </div>
        </div>
        <div class="look">
          <span class="look__label">Colour</span>
          <div class="look__choices" role="group" aria-label="Accent colour">
            @for (k of accents; track k) {
              <button
                type="button"
                class="swatch"
                [class.swatch--on]="accent.key() === k"
                [style.background]="swatchOf(k)"
                [attr.aria-label]="nameOf(k)"
                [attr.aria-pressed]="accent.key() === k"
                [title]="nameOf(k)"
                (click)="accent.set(k)"
              ></button>
            }
            <button mkButton variant="ghost" size="sm" type="button" [disabled]="accent.key() === null" (click)="accent.reset()">Default</button>
          </div>
        </div>
      </mk-card>

      @if (!drive.meta()?.demo) {
        <mk-card class="block">
          <h2>Name</h2>
          <form class="form" (submit)="saveName($event)">
            <mk-form-field label="Display name">
              <input mkInput [value]="name()" (input)="name.set($any($event.target).value)" autocomplete="name" required />
            </mk-form-field>
            <div>
              <button mkButton type="submit" [loading]="savingName()" [disabled]="!name().trim() || name().trim() === drive.me()?.name">Save name</button>
            </div>
          </form>
        </mk-card>
      }

      @if (drive.meta()?.nas && drive.me()?.via === 'session') {
        <mk-card class="block">
          <h2>Network access</h2>
          @if (smb(); as s) {
            <p class="muted">
              Finder, Explorer and phones open this NAS's shares with your drive account. Sign in there as <strong class="mono">{{ s.name }}</strong> with the
              SMB password below{{ s.hasPassword ? '' : ' — none is set yet' }}; the server is <code>smb://{{ s.host }}</code
              >.
            </p>
            <form class="form" (submit)="saveSmb($event)">
              <mk-form-field
                [label]="s.hasPassword ? 'New SMB password' : 'SMB password'"
                hint="At least 10 characters. Separate from your drive password, used only for SMB."
              >
                <mk-password-input [(value)]="smbPassword" autocomplete="new-password" [minLength]="10" />
              </mk-form-field>
              <div>
                <button mkButton type="submit" [loading]="savingSmb()" [disabled]="smbPassword().length < 10">
                  {{ s.hasPassword ? 'Change SMB password' : 'Set SMB password' }}
                </button>
              </div>
            </form>
          } @else {
            <p class="muted">Loading…</p>
          }
        </mk-card>
      }

      @if (drive.me()?.via === 'session') {
        @if (!drive.meta()?.demo) {
          <mk-card class="block">
            <h2>Password</h2>
            <p class="muted">Changing it signs out every other device.</p>
            <form class="form" (submit)="savePassword($event)">
              <mk-form-field label="Current password" [error]="pwError()">
                <mk-password-input [(value)]="current" autocomplete="current-password" />
              </mk-form-field>
              <mk-form-field label="New password" hint="At least 10 characters.">
                <mk-password-input [(value)]="next" autocomplete="new-password" showStrength [minLength]="10" />
              </mk-form-field>
              <div><button mkButton type="submit" [loading]="savingPw()" [disabled]="!current() || next().length < 10">Change password</button></div>
            </form>
          </mk-card>
        }
      }
    </app-settings>
  `,
  styles: [
    `
      .demo-note {
        margin: 0 0 var(--mk-space-4);
      }
      .look {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
        margin-top: var(--mk-space-3);
      }
      .look__label {
        min-width: 4rem;
        color: var(--mk-text-muted);
      }
      .look__choices {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .swatch {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid transparent;
        box-shadow: 0 0 0 1px var(--mk-border-subtle);
        cursor: pointer;
        padding: 0;
      }
      .swatch--on {
        border-color: var(--mk-surface);
        box-shadow: 0 0 0 2px var(--mk-text);
      }
      .swatch:focus-visible {
        outline: 2px solid var(--mk-focus-ring);
        outline-offset: 2px;
      }
      .block {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
      h2 {
        font-size: var(--mk-font-size-lg);
        margin: 0 0 var(--mk-space-3);
      }
      .form {
        display: grid;
        gap: var(--mk-space-4);
        max-width: 420px;
      }
      p {
        margin: 0 0 var(--mk-space-4);
      }
    `,
  ],
})
export class AccountPage {
  protected readonly drive = inject(DriveService);
  protected readonly theme = inject(MkThemeService);
  protected readonly accent = inject(MkAccentService);
  protected readonly themes: { value: MkThemePreference; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'Same as the device' },
  ];
  protected readonly accents = MK_ACCENT_ORDER;
  protected readonly swatchOf = mkAccentSwatch;
  nameOf(k: MkAccentKey): string {
    return MK_ACCENTS[k].name;
  }
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  protected readonly name = signal(this.drive.me()?.name ?? '');
  protected readonly savingName = signal(false);
  protected readonly current = signal('');
  protected readonly smb = signal<{ name: string; hasPassword: boolean; host: string } | null>(null);
  protected readonly smbPassword = signal('');
  protected readonly savingSmb = signal(false);
  protected readonly next = signal('');
  protected readonly savingPw = signal(false);
  protected readonly pwError = signal<string | null>(null);

  constructor() {
    void this.drive.ready().then(async () => {
      if (!this.drive.meta()?.nas) return;
      try {
        this.smb.set(await this.api.nas.mySmb());
      } catch {
        this.smb.set({ name: '?', hasPassword: false, host: '?' });
      }
    });
    void this.drive.ready().then(() => this.name.set(this.drive.me()?.name ?? ''));
  }

  async saveName(ev: Event): Promise<void> {
    ev.preventDefault();
    this.savingName.set(true);
    try {
      await this.api.rename(this.name().trim());
      this.drive.setName(this.name().trim());
      this.toast.success('Name saved');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.savingName.set(false);
    }
  }

  async saveSmb(ev: Event): Promise<void> {
    ev.preventDefault();
    this.savingSmb.set(true);
    try {
      const r = await this.api.nas.setMySmbPassword(this.smbPassword());
      this.smb.update((s) => (s ? { ...s, hasPassword: r.hasPassword } : s));
      this.smbPassword.set('');
      this.toast.success('SMB password set');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.savingSmb.set(false);
    }
  }

  async savePassword(ev: Event): Promise<void> {
    ev.preventDefault();
    this.savingPw.set(true);
    this.pwError.set(null);
    try {
      await this.api.changePassword(this.current(), this.next());
      this.current.set('');
      this.next.set('');
      this.toast.success('Password changed');
    } catch (e) {
      this.pwError.set(errorMessage(e));
    } finally {
      this.savingPw.set(false);
    }
  }
}
