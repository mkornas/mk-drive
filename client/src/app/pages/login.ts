import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { computed } from '@angular/core';
import { MkFormField, MkInput, MkPasswordInput } from '@mk-kit/ui/forms';
import { MkAlert } from '@mk-kit/ui/feedback';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { AuthCard } from '../shared/auth-card';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthCard, MkFormField, MkInput, MkPasswordInput, MkButton, MkAlert, MkIcon],
  template: `
    <app-auth-card title="Sign in" lead="Use the account you were given for this drive.">
      @if (drive.meta()?.demo) {
        <p class="demo">
          Demo drive, reset every night.
          @if (drive.meta()?.demoAccount; as a) {
            Sign in as <strong>{{ a.email }}</strong> with <strong>{{ a.password }}</strong>.
          } @else {
            Sign in with the demo account you were given.
          }
        </p>
      }
      @if (reason(); as reason) {
        <mk-alert tone="warning" class="reason">{{ reason }}</mk-alert>
      }
      @if (drive.meta()?.sso; as sso) {
        <a mkButton fullWidth class="sso" [href]="'/auth/login?next=' + encodeNext()"><mk-icon name="key" /> Sign in with {{ sso.name }}</a>
        @if (passwordLogin()) {
          <div class="or muted"><span>or with a password</span></div>
        }
      }
      @if (!passwordLogin() && drive.meta()?.passwordLoginLocal) {
        <p class="muted hint">Password sign-in is available on the local network.</p>
      } @else if (!passwordLogin() && !drive.meta()?.sso) {
        <mk-alert tone="warning" class="reason">Password sign-in is not offered from this network.</mk-alert>
      }
      @if (passwordLogin()) {
      <form (submit)="submit($event)" class="form">
        <mk-form-field label="Email">
          <input mkInput type="email" autocomplete="username" [value]="email()" (input)="email.set($any($event.target).value)" placeholder="you@example.com" required />
        </mk-form-field>
        <mk-form-field label="Password" [error]="error()">
          <mk-password-input [(value)]="password" autocomplete="current-password" />
        </mk-form-field>
        <button mkButton type="submit" fullWidth [loading]="busy()" [disabled]="!email() || !password()">Sign in</button>
      </form>
      }
    </app-auth-card>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-4);
      }
      .demo {
        margin: 0 0 var(--mk-space-4);
        padding: var(--mk-space-3) var(--mk-space-4);
        border-radius: var(--mk-radius-md);
        background: var(--mk-primary-subtle);
        color: var(--mk-primary-subtle-text);
        font-size: var(--mk-font-size-sm);
        line-height: var(--mk-line-height-relaxed);
      }
      .demo strong {
        color: var(--mk-text);
        font-weight: var(--mk-font-weight-semibold);
      }
      .reason {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
      .sso {
        margin-bottom: var(--mk-space-4);
      }
      .hint {
        margin: 0;
        text-align: center;
        font-size: var(--mk-font-size-sm);
      }
      .or {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        font-size: var(--mk-font-size-sm);
        margin-bottom: var(--mk-space-4);
      }
      .or::before,
      .or::after {
        content: '';
        flex: 1;
        border-top: 1px solid var(--mk-border-subtle);
      }
    `,
  ],
})
export class LoginPage {
  protected readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** From the server (a refused Access identity) or from the SSO callback (`?reason=`). */
  protected readonly reason = computed(() => this.route.snapshot.queryParamMap.get('reason') ?? this.drive.meta()?.reason ?? null);
  /** Until the meta arrives, assume the form is wanted (no flash of an empty card). */
  protected readonly passwordLogin = computed(() => this.drive.meta()?.passwordLogin ?? true);

  encodeNext(): string {
    return encodeURIComponent(this.next());
  }

  constructor() {
    void this.drive.ready().then(() => {
      if (this.drive.meta()?.setupRequired) void this.router.navigate(['/setup']);
      else if (this.drive.signedIn()) void this.router.navigateByUrl(this.next());
    });
  }

  private next(): string {
    const n = this.route.snapshot.queryParamMap.get('next');
    return n && n.startsWith('/') && !n.startsWith('/login') ? n : '/';
  }

  async submit(ev: Event): Promise<void> {
    ev.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      const id = await this.api.login(this.email(), this.password());
      await this.drive.signedInAs(id);
      await this.router.navigateByUrl(this.next());
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
