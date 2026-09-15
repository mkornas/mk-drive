import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkAvatar, MkTag } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import type { User } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { ago } from '../../core/format';
import { SettingsShell } from './shell';
import { PersonDialog, type PersonDialogData } from './person-dialog';

@Component({
  selector: 'app-people',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkIcon, MkAvatar, MkTag, MkEmptyState, MkSpinner, MkTooltip],
  template: `
    <app-settings heading="People" description="Who can open this drive, and what each person may see.">
      <div class="toolbar"><button mkButton (click)="add()"><mk-icon name="user-plus" /> Add a person</button></div>
      @if (users() === null) {
        <mk-spinner />
      } @else if (users()!.length === 0) {
        <mk-empty-state icon="users" title="Just you" description="Add someone and choose which locations they may open." />
      } @else {
        <ul class="list">
          @for (u of users(); track u.id) {
            <li class="person" [class.person--off]="u.disabled">
              <mk-avatar [name]="u.name" size="md" />
              <div class="person__main">
                <div class="person__title">
                  {{ u.name }}
                  @if (u.role === 'admin') {<mk-tag size="sm" tone="primary">admin</mk-tag>}
                  @if (u.disabled) {<mk-tag size="sm" tone="neutral">disabled</mk-tag>}
                  @if (u.id === drive.me()?.id) {<span class="muted">(you)</span>}
                </div>
                <div class="muted person__meta">{{ u.email }} · {{ u.lastLoginAt ? 'last sign-in ' + f.ago(u.lastLoginAt) : 'never signed in' }}</div>
                <div class="person__access muted">{{ access(u) }}</div>
              </div>
              <div class="person__actions">
                <button mkButton variant="ghost" size="sm" iconOnly aria-label="Edit" (click)="edit(u)"><mk-icon name="edit" size="sm" /></button>
                <button mkButton variant="ghost" size="sm" iconOnly aria-label="Set password" mkTooltip="Set a password" (click)="setPassword(u)"><mk-icon name="key" size="sm" /></button>
                @if (u.id !== drive.me()?.id) {
                  <button mkButton variant="ghost" size="sm" iconOnly [attr.aria-label]="u.disabled ? 'Enable' : 'Disable'" (click)="toggle(u)"><mk-icon [name]="u.disabled ? 'circle-check' : 'ban'" size="sm" /></button>
                  <button mkButton variant="ghost" size="sm" iconOnly tone="danger" aria-label="Remove" (click)="remove(u)"><mk-icon name="trash" size="sm" /></button>
                }
              </div>
            </li>
          }
        </ul>
      }
    </app-settings>
  `,
  styles: [
    `
      .toolbar {
        margin-bottom: var(--mk-space-4);
      }
      .list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: var(--mk-space-2);
      }
      .person {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        padding: var(--mk-space-3) var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
      }
      .person--off {
        opacity: 0.6;
      }
      .person__main {
        flex: 1;
        min-width: 0;
      }
      .person__title {
        font-weight: 500;
        display: flex;
        gap: var(--mk-space-2);
        align-items: center;
        flex-wrap: wrap;
      }
      .person__meta,
      .person__access {
        font-size: var(--mk-font-size-sm);
      }
      .person__actions {
        display: flex;
        gap: 2px;
      }
    `,
  ],
})
export class PeoplePage {
  protected readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly users = signal<User[] | null>(null);
  protected readonly f = { ago };

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    await this.drive.ready();
    this.users.set(await this.api.users());
  }

  access(u: User): string {
    if (u.role === 'admin') return 'Every location';
    const parts = Object.entries(u.grants).map(([loc, level]) => `${loc}${level === 'write' ? '' : ' (view)'}`);
    return parts.length ? parts.join(', ') : 'No locations yet';
  }

  private open(user: User | null): void {
    const ref = this.dialog.open<PersonDialog, User | undefined, PersonDialogData>(PersonDialog, { data: { user, locations: this.drive.locations() }, size: 'md' });
    void ref.afterClosed.then((saved) => {
      if (!saved) return;
      this.users.update((list) => (list ? (user ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved]) : list));
      this.toast.success(user ? 'Changes saved' : `${saved.name} added`);
    });
  }

  add(): void {
    this.open(null);
  }

  /** An admin sets anyone's password, their own included — the way back in after a forgotten one. */
  async setPassword(u: User): Promise<void> {
    const password = await this.dialog.prompt({ title: `Set a password for ${u.name}`, label: 'New password', placeholder: 'at least 10 characters', confirmText: 'Set' });
    if (!password) return;
    if (password.length < 10) {
      this.toast.warning('At least 10 characters');
      return;
    }
    try {
      await this.api.updateUser(u.id, { password });
      this.toast.success(`Password set for ${u.name}`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  edit(u: User): void {
    this.open(u);
  }

  async toggle(u: User): Promise<void> {
    try {
      const saved = await this.api.updateUser(u.id, { disabled: !u.disabled });
      this.users.update((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null);
      this.toast.success(saved.disabled ? `${u.name} disabled` : `${u.name} enabled`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async remove(u: User): Promise<void> {
    if (!(await this.dialog.confirm({ title: `Remove ${u.name}?`, message: 'They lose access immediately. Their files stay where they are.', confirmText: 'Remove', tone: 'danger' }))) return;
    try {
      await this.api.deleteUser(u.id);
      this.users.update((list) => list?.filter((x) => x.id !== u.id) ?? null);
      this.toast.success(`${u.name} removed`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
