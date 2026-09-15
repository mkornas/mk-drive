import { ChangeDetectionStrategy, Component, computed, inject, signal, type WritableSignal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkPasswordInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import type { AccessLevel, Location, Role, User } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';

export interface PersonDialogData {
  user: User | null;
  locations: Location[];
}

const ROLES: MkSelectOption[] = [
  { label: 'Member — sees only the locations chosen below', value: 'member' },
  { label: 'Admin — sees everything, manages people', value: 'admin' },
];
const LEVELS: MkSelectOption[] = [
  { label: 'No access', value: 'none' },
  { label: 'Can view and download', value: 'read' },
  { label: 'Can change', value: 'write' },
];

/** Add or edit a person: identity, role, password, and what they may open. */
@Component({
  selector: 'app-person-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkFormField, MkInput, MkPasswordInput, MkSelect, MkIcon],
  template: `
    <mk-dialog [dialogTitle]="data.user ? 'Edit ' + data.user.name : 'Add a person'">
      <form class="form" (submit)="save($event)" id="person-form">
        <div class="two">
          <mk-form-field label="Name">
            <input mkInput [value]="name()" (input)="name.set($any($event.target).value)" required autocomplete="off" />
          </mk-form-field>
          <mk-form-field label="Email">
            <input mkInput type="email" [value]="email()" (input)="email.set($any($event.target).value)" [disabled]="!!data.user" required autocomplete="off" />
          </mk-form-field>
        </div>
        <mk-form-field label="Role">
          <mk-select [options]="roles" [(value)]="role" />
        </mk-form-field>
        <mk-form-field [label]="data.user ? 'New password (leave empty to keep)' : 'Password'" hint="At least 10 characters. Share it with them once; they can change it later.">
          <mk-password-input [(value)]="password" autocomplete="new-password" [minLength]="10" />
        </mk-form-field>

        @if (role() === 'member') {
          <fieldset class="grants">
            <legend>Access</legend>
            @for (row of rows; track row.loc.name) {
              <div class="grant">
                <span class="grant__name"><mk-icon [name]="row.loc.icon" size="sm" /> {{ row.loc.name }}@if (row.loc.mode === 'ro') {<span class="muted"> (read-only)</span>}</span>
                <mk-select class="grant__level" [options]="row.loc.mode === 'ro' ? levelsRo : levels" [(value)]="row.level" size="sm" />
              </div>
            }
          </fieldset>
        }
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </form>
      <div mkDialogFooter class="footer">
        <button mkButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button mkButton type="submit" form="person-form" [loading]="busy()" [disabled]="!valid()">{{ data.user ? 'Save changes' : 'Add person' }}</button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-4);
      }
      .two {
        display: grid;
        gap: var(--mk-space-4);
        grid-template-columns: 1fr 1fr;
      }
      @media (max-width: 560px) {
        .two {
          grid-template-columns: 1fr;
        }
      }
      .grants {
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        padding: var(--mk-space-3) var(--mk-space-4);
        margin: 0;
        display: grid;
        gap: var(--mk-space-2);
      }
      legend {
        padding: 0 var(--mk-space-2);
        font-weight: 500;
      }
      .grant {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--mk-space-3);
      }
      .grant__name {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
      }
      .grant__level {
        width: 220px;
      }
      .error {
        color: var(--mk-danger-text);
        margin: 0;
      }
      .footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--mk-space-2);
      }
    `,
  ],
})
export class PersonDialog {
  protected readonly data = inject<PersonDialogData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<User | undefined>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  protected readonly roles = ROLES;
  protected readonly levels = LEVELS;
  protected readonly levelsRo = LEVELS.slice(0, 2);

  protected readonly name = signal(this.data.user?.name ?? '');
  protected readonly email = signal(this.data.user?.email ?? '');
  protected readonly role = signal<Role>(this.data.user?.role ?? 'member');
  protected readonly password = signal('');
  /** One writable level per location; read back into a grants object on save. */
  protected readonly rows: { loc: Location; level: WritableSignal<AccessLevel> }[] = this.data.locations.map((loc) => ({ loc, level: signal<AccessLevel>(this.data.user?.grants[loc.name] ?? 'none') }));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly valid = computed(() => !!this.name().trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email()) && (this.data.user ? this.password().length === 0 || this.password().length >= 10 : this.password().length >= 10));

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.valid()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const grants: Record<string, AccessLevel> = {};
      if (this.role() === 'member') for (const r of this.rows) if (r.level() !== 'none') grants[r.loc.name] = r.level();
      const saved = this.data.user
        ? await this.api.updateUser(this.data.user.id, { name: this.name().trim(), role: this.role(), grants, ...(this.password() ? { password: this.password() } : {}) })
        : await this.api.createUser({ email: this.email().trim(), name: this.name().trim(), role: this.role(), password: this.password(), grants });
      this.ref.close(saved);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
