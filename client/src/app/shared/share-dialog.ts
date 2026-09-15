import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkDialog, MkToastService } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkTag } from '@mk-kit/ui/data';
import type { Entry, Share, ShareMode, UserShare } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { ago, dateTime } from '../core/format';

export interface ShareDialogData {
  entry: Entry;
}

const LEVELS: MkSelectOption[] = [
  { label: 'Can view', value: 'read' },
  { label: 'Can edit', value: 'write' },
];

const FOLDER_MODES: MkSelectOption[] = [
  { label: 'Browse and download', value: 'browse' },
  { label: 'Download as one zip', value: 'download' },
  { label: 'Add files only (file request)', value: 'upload' },
];

const EXPIRY: MkSelectOption[] = [
  { label: 'Never expires', value: 0 },
  { label: 'Expires in a day', value: 1 },
  { label: 'Expires in a week', value: 7 },
  { label: 'Expires in a month', value: 30 },
];

/** Create and manage the public links of one file or folder, and who else on this drive may open it. */
@Component({
  selector: 'app-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkIcon, MkFormField, MkInput, MkSelect, MkTag],
  template: `
    <mk-dialog [dialogTitle]="'Share “' + data.entry.name + '”'">
      @if (created(); as s) {
        <div class="made">
          <p class="lead">Anyone with this link can {{ s.kind === 'dir' ? (s.mode === 'browse' ? 'browse and download the folder' : s.mode === 'upload' ? 'add files to the folder, without seeing what is in it' : 'download the folder as a zip') : 'view and download the file' }}@if (s.locked) {, after entering the password}.</p>
          <div class="link">
            <input mkInput readonly [value]="api.shareLink(s.id)" (focus)="$any($event.target).select()" aria-label="Share link" />
            <button mkButton (click)="copy(s)"><mk-icon name="copy" size="sm" /> Copy</button>
          </div>
          <p class="muted small">{{ s.expiresAt ? 'Expires ' + f.dateTime(s.expiresAt) : 'Does not expire' }} · you can remove it below at any time.</p>
        </div>
      } @else {
        <form class="form" (submit)="create($event)">
          <mk-form-field label="Link lifetime">
            <mk-select [options]="expiry" [(value)]="days" />
          </mk-form-field>
          <mk-form-field label="Password" hint="Optional. Share it separately from the link.">
            <input mkInput [value]="password()" (input)="password.set($any($event.target).value)" autocomplete="off" placeholder="None" />
          </mk-form-field>
          @if (data.entry.kind === 'dir') {
            <mk-form-field label="What the link allows" [hint]="mode() === 'upload' ? 'A file request: visitors only send files in, never see the folder. Names that clash are kept side by side.' : ''">
              <mk-select [options]="folderModes" [(value)]="mode" />
            </mk-form-field>
          }
          <div><button mkButton type="submit" [loading]="busy()"><mk-icon name="link" size="sm" /> Create link</button></div>
        </form>
      }

      @if (true) {
        <h3>People on this drive</h3>
        <form class="people" (submit)="shareWith($event)">
          <input mkInput type="email" [value]="email()" (input)="email.set($any($event.target).value)" placeholder="email of an account here" autocomplete="off" aria-label="Email" />
          <mk-select [options]="levels" [(value)]="level" aria-label="Access" />
          <button mkButton type="submit" [loading]="sharing()" [disabled]="!email()"><mk-icon name="users" size="sm" /> Share</button>
        </form>
        @if (people().length) {
          <ul class="list">
            @for (p of people(); track p.id) {
              <li class="item">
                <div class="item__main">
                  <div class="row"><span>{{ p.user.name }}</span> <span class="muted small">{{ p.user.email }}</span> <mk-tag size="sm" [tone]="p.level === 'write' ? 'primary' : 'neutral'">{{ p.level === 'write' ? 'can edit' : 'can view' }}</mk-tag></div>
                  <div class="muted small">shared {{ f.ago(p.createdAt) }}@if (p.owner.email !== drive.me()?.email) { by {{ p.owner.name }}}</div>
                </div>
                <button mkButton variant="ghost" size="sm" iconOnly tone="danger" aria-label="Stop sharing" (click)="unshare(p)"><mk-icon name="user-x" size="sm" /></button>
              </li>
            }
          </ul>
        }
      }

      @if (existing().length) {
        <h3>Existing links</h3>
        <ul class="list">
          @for (s of existing(); track s.id) {
            <li class="item">
              <div class="item__main">
                <div class="row">
                  <span class="mono small">…/s/{{ s.id }}</span>
                  @if (s.locked) {<mk-tag size="sm">password</mk-tag>}
                  @if (s.kind === 'dir') {<mk-tag size="sm" [tone]="s.mode === 'upload' ? 'primary' : 'neutral'">{{ s.mode === 'browse' ? 'browse' : s.mode === 'upload' ? 'file request' : 'zip only' }}</mk-tag>}
                </div>
                <div class="muted small">{{ s.expiresAt ? 'expires ' + f.ago(s.expiresAt).replace(' ago', '') : 'no expiry' }} · opened {{ s.hits }}×{{ s.lastHitAt ? ', last ' + f.ago(s.lastHitAt) : '' }}</div>
              </div>
              <button mkButton variant="ghost" size="sm" iconOnly aria-label="Copy link" (click)="copy(s)"><mk-icon name="copy" size="sm" /></button>
              <button mkButton variant="ghost" size="sm" iconOnly tone="danger" aria-label="Remove link" (click)="remove(s)"><mk-icon name="link-off" size="sm" /></button>
            </li>
          }
        </ul>
      }
      <div mkDialogFooter class="footer"><button mkButton variant="ghost" (click)="ref.close()">Done</button></div>
    </mk-dialog>
  `,
  styles: [
    `
      :host {
        display: block;
        width: min(520px, calc(100vw - 48px));
      }
      .lead {
        margin: 0 0 var(--mk-space-3);
      }
      .link {
        display: flex;
        gap: var(--mk-space-2);
      }
      .link input {
        flex: 1;
        min-width: 0;
      }
      .form {
        display: grid;
        gap: var(--mk-space-4);
      }
      .people {
        display: flex;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .people input {
        flex: 1 1 12rem;
        min-width: 0;
      }
      .people mk-select {
        flex: 0 1 9rem;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      h3 {
        font-size: var(--mk-font-size-sm);
        font-weight: 600;
        margin: var(--mk-space-5) 0 var(--mk-space-2);
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .item {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        padding: var(--mk-space-2) 0;
        border-top: 1px solid var(--mk-border-subtle);
      }
      .item__main {
        flex: 1;
        min-width: 0;
      }
      .footer {
        display: flex;
        justify-content: flex-end;
      }
    `,
  ],
})
export class ShareDialog {
  protected readonly data = inject<ShareDialogData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<void>>(MkOverlayRef);
  protected readonly api = inject(ApiService);
  protected readonly drive = inject(DriveService);
  private readonly toast = inject(MkToastService);
  protected readonly f = { ago, dateTime };
  protected readonly expiry = EXPIRY;
  protected readonly days = signal<number>(7);
  protected readonly password = signal('');
  protected readonly folderModes = FOLDER_MODES;
  protected readonly mode = signal<ShareMode>('browse');
  protected readonly busy = signal(false);
  protected readonly created = signal<Share | null>(null);
  protected readonly existing = signal<Share[]>([]);
  protected readonly locked = computed(() => this.password().length > 0);
  protected readonly levels = LEVELS;
  protected readonly email = signal('');
  protected readonly level = signal<'read' | 'write'>('read');
  protected readonly sharing = signal(false);
  protected readonly people = signal<UserShare[]>([]);

  constructor() {
    void this.api.sharesFor(this.data.entry.path).then((s) => this.existing.set(s)).catch(() => {});
    void this.api.userSharesFor(this.data.entry.path).then((p) => this.people.set(p)).catch(() => {});
  }

  async shareWith(ev: Event): Promise<void> {
    ev.preventDefault();
    this.sharing.set(true);
    try {
      const p = await this.api.shareWithUser(this.data.entry.path, this.email().trim(), this.level());
      this.people.update((l) => [...l.filter((x) => x.id !== p.id), p]);
      this.email.set('');
      this.toast.success(`Shared with ${p.user.name}`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.sharing.set(false);
    }
  }

  async unshare(p: UserShare): Promise<void> {
    try {
      await this.api.removeUserShare(p.id);
      this.people.update((l) => l.filter((x) => x.id !== p.id));
      this.toast.success(`No longer shared with ${p.user.name}`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async create(ev: Event): Promise<void> {
    ev.preventDefault();
    this.busy.set(true);
    try {
      const days = Number(this.days());
      const s = await this.api.createShare(this.data.entry.path, { expiresAt: days ? Date.now() + days * 86_400_000 : null, password: this.password() || undefined, mode: this.data.entry.kind === 'dir' ? this.mode() : 'browse' });
      this.created.set(s);
      this.existing.update((l) => [s, ...l]);
      await this.copy(s, true);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async copy(s: Share, quiet = false): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.api.shareLink(s.id));
      this.toast.success('Link copied');
    } catch {
      if (!quiet) this.toast.warning('Could not copy — select the link and copy it by hand');
    }
  }

  async remove(s: Share): Promise<void> {
    try {
      await this.api.deleteShare(s.id);
      this.existing.update((l) => l.filter((x) => x.id !== s.id));
      if (this.created()?.id === s.id) this.created.set(null);
      this.toast.success('Link removed');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
