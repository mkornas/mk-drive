import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkFormField, MkInput, MkPasswordInput } from '@mk-kit/ui/forms';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { AuthCard } from '../shared/auth-card';

/** First run: there is no account yet, so this one becomes the admin. */
@Component({
  selector: 'app-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthCard, MkFormField, MkInput, MkPasswordInput, MkButton],
  template: `
    <app-auth-card title="Welcome" lead="This drive has no accounts yet. Create yours — it will be the admin account that invites everyone else.">
      <form (submit)="submit($event)" class="form">
        <mk-form-field label="Your name">
          <input mkInput autocomplete="name" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="Alex" required />
        </mk-form-field>
        <mk-form-field label="Email" hint="If the drive sits behind Cloudflare Access, use the same address you sign in with there.">
          <input mkInput type="email" autocomplete="username" [value]="email()" (input)="email.set($any($event.target).value)" placeholder="you@example.com" required />
        </mk-form-field>
        <mk-form-field label="Password" hint="At least 10 characters." [error]="error()">
          <mk-password-input [(value)]="password" autocomplete="new-password" showStrength [minLength]="10" />
        </mk-form-field>
        <button mkButton type="submit" fullWidth [loading]="busy()" [disabled]="!name() || !email() || password().length < 10">Create the admin account</button>
      </form>
    </app-auth-card>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-4);
      }
    `,
  ],
})
export class SetupPage {
  private readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.drive.ready().then(() => {
      if (!this.drive.meta()?.setupRequired) void this.router.navigate([this.drive.signedIn() ? '/' : '/login']);
    });
  }

  async submit(ev: Event): Promise<void> {
    ev.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      const id = await this.api.setup(this.email(), this.name(), this.password());
      await this.drive.signedInAs(id);
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
