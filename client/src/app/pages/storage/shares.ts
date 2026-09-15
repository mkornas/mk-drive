import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkEmptyState } from '@mk-kit/ui/status';
import type { Share, SmbUser, Version } from '../../../../../shared/nas';
import { ApiService } from '../../core/api.service';
import { StorageShell } from './shell';
import { loader } from './load';
import { ShareDialog, type ShareDialogData } from './share-dialog';

/** What is handed out over the network, how to connect, and who has an SMB password. */
@Component({
  selector: 'app-storage-shares',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StorageShell, MkButton, MkTag, MkIcon, MkEmptyState, MkAlert],
  template: `
    <app-storage
      heading="Shares"
      description="Datasets handed out over SMB and NFS. Sharing is switched on per dataset, on the Datasets page or here."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="q.run()"
    >
      @if (q.data(); as d) {
        @if (d.shares.length === 0) {
          <mk-empty-state icon="globe" title="Nothing is shared yet" description="Open the Datasets page and choose Share on a dataset." />
        }
        @if (smbShared() && canConnect().length === 0) {
          <mk-alert tone="warning" title="Nobody can connect over SMB yet" class="alert">
            Set an SMB password under <a routerLink="/settings/account">Settings → Account → Network access</a>. Only drive accounts with an SMB password can
            open these shares; a login on the box itself (like the one made by the installer) is not one.
          </mk-alert>
        }
        <ul class="list">
          @for (s of d.shares; track s.dataset) {
            <li class="share">
              <div class="share__head">
                <span class="share__name">{{ s.name }}</span>
                <span class="mono muted">{{ s.dataset }}</span>
                <span class="spacer"></span>
                <button mkButton variant="ghost" size="sm" (click)="edit(s)"><mk-icon name="settings" size="sm" /> Change</button>
              </div>
              @if (!s.mountpoint) {
                <p class="warn">The dataset is not mounted; the share is off until it is.</p>
              }
              <div class="ways">
                @if (s.smb) {
                  <div class="way">
                    <mk-tag size="sm" tone="primary">SMB</mk-tag>
                    <code>smb://{{ d.version.hostname }}/{{ s.name }}</code>
                    @if (s.timeMachine) {
                      <mk-tag size="sm" tone="neutral">Time Machine</mk-tag>
                    }
                  </div>
                }
                @if (s.nfs) {
                  <div class="way">
                    <mk-tag size="sm" tone="primary">NFS</mk-tag>
                    <code>{{ d.version.hostname }}:{{ s.mountpoint }}</code>
                    <span class="muted small">for {{ s.nfsClients.length ? s.nfsClients.join(', ') : 'the private networks' }}</span>
                  </div>
                }
              </div>
            </li>
          }
        </ul>

        <h2>Who can connect over SMB</h2>
        <p class="muted">
          Everyone with a drive account may set an SMB password on their <a routerLink="/settings/account">account page</a>; that is what Finder or Explorer
          asks for. Whoever has one may open every SMB share. Logins on the box itself are not SMB accounts.
        </p>
        @if (d.users.length === 0) {
          <p class="muted">Nobody yet — no one has set an SMB password.</p>
        } @else {
          <ul class="users">
            @for (u of d.users; track u.name) {
              <li>
                <span class="mono">{{ u.name }}</span>
                <mk-tag size="sm" [tone]="u.hasPassword ? 'success' : 'neutral'">{{ u.hasPassword ? 'password set' : 'no password' }}</mk-tag>
              </li>
            }
          </ul>
        }
      }
    </app-storage>
  `,
  styles: [
    `
      .list {
        list-style: none;
        padding: 0;
        margin: 0 0 var(--mk-space-6);
        display: grid;
        gap: var(--mk-space-3);
      }
      .share {
        padding: var(--mk-space-3) var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
      }
      .share__head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
      }
      .share__name {
        font-weight: 600;
        font-size: var(--mk-font-size-lg);
      }
      .spacer {
        flex: 1;
      }
      .ways {
        display: grid;
        gap: var(--mk-space-2);
        margin-top: var(--mk-space-3);
      }
      .way {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      code {
        font-family: var(--mk-font-mono);
        font-size: var(--mk-font-size-sm);
        user-select: all;
      }
      .warn {
        color: var(--mk-warning);
        margin: var(--mk-space-2) 0 0;
        font-size: var(--mk-font-size-sm);
      }
      .alert {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
      h2 {
        font-size: var(--mk-font-size-lg);
        margin: 0 0 var(--mk-space-2);
      }
      .users {
        list-style: none;
        padding: 0;
        margin: var(--mk-space-3) 0 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class StorageSharesPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly q = loader<{ shares: Share[]; users: SmbUser[]; version: Version }>(async () => {
    const [shares, users, version] = await Promise.all([this.api.nas.shares(), this.api.nas.users(), this.api.nas.version()]);
    return { shares, users, version };
  });

  /** Names that can sign in over SMB: a user without a password is in the database but Samba lets nobody in on it. */
  protected readonly canConnect = computed(() => (this.q.data()?.users ?? []).filter((u) => u.hasPassword).map((u) => u.name));
  protected readonly smbShared = computed(() => (this.q.data()?.shares ?? []).some((s) => s.smb));

  constructor() {
    void this.q.run();
  }

  async edit(s: Share): Promise<void> {
    const ref = this.dialog.open<ShareDialog, Share | null | undefined, ShareDialogData>(ShareDialog, {
      data: { dataset: s.dataset, share: s, host: this.q.data()?.version.hostname ?? 'nas' },
      size: 'md',
    });
    const result = await ref.afterClosed;
    if (result === undefined) return;
    this.toast.success(result ? `${s.name} shared` : `${s.name} is no longer shared`);
    await this.q.run();
  }
}
