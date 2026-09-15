import { ChangeDetectionStrategy, Component, computed, inject, signal, type WritableSignal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import type { Share, SmbAccess } from '../../../../../shared/nas';
import type { ShareAccessAccount } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';

export interface ShareDialogData {
  dataset: string;
  share: Share | null;
  host: string;
}

type Level = 'none' | SmbAccess['level'];

const LEVELS: MkSelectOption[] = [
  { label: 'No access', value: 'none' },
  { label: 'Read', value: 'read' },
  { label: 'Read and write', value: 'write' },
];

/** Hand a dataset out over the network, or take it back: SMB for Finder and Explorer (and Time Machine), NFS for other machines. */
@Component({
  selector: 'app-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkCheckbox, MkFormField, MkInput, MkSelect],
  template: `
    <mk-dialog [dialogTitle]="'Share ' + data.dataset">
      <form class="form" id="share-form" (submit)="save($event)">
        <section class="proto">
          <mk-checkbox [(checked)]="smb"
            >Over SMB — Finder, Explorer, phones; people sign in with their drive account and the SMB password from their account page</mk-checkbox
          >
          @if (smb()) {
            <div class="sub">
              <mk-checkbox [(checked)]="timeMachine">Let Macs use it for Time Machine backups</mk-checkbox>
              <p class="how">
                Connect to <code>smb://{{ data.host }}/{{ name }}</code>
              </p>
              <h3>Who can open it</h3>
              @if (accessError()) {
                <p class="warn">Could not load the accounts ({{ accessError() }}). Saving keeps the list the share has.</p>
              } @else if (rows(); as rows) {
                <ul class="people">
                  @for (row of rows; track row.account.userId) {
                    <li class="person">
                      <div class="person__main">
                        <div>
                          {{ row.account.name }} <span class="muted small">{{ row.account.email }}</span>
                        </div>
                        @if (!row.account.hasPassword) {
                          <div class="muted small">no SMB password yet — they set one under Settings → Account</div>
                        }
                      </div>
                      <mk-select class="person__level" [options]="levels" [(value)]="row.level" size="sm" [ariaLabel]="'SMB access for ' + row.account.name" />
                    </li>
                  }
                </ul>
                @if (nobody()) {
                  <p class="warn">Nobody is chosen, so the share will not be offered over SMB.</p>
                }
              } @else {
                <p class="how">Loading the accounts…</p>
              }
            </div>
          }
        </section>
        <section class="proto">
          <mk-checkbox [(checked)]="nfs">Over NFS — other Linux boxes and servers; no accounts, whoever is on the allowed networks</mk-checkbox>
          @if (nfs()) {
            <div class="sub">
              <mk-form-field label="Allowed networks and hosts" hint="Comma-separated. Empty = the private networks (10/8, 172.16/12, 192.168/16)."
                ><input mkInput [value]="clients()" (input)="clients.set($any($event.target).value)" placeholder="192.168.1.0/24, laptop"
              /></mk-form-field>
              <p class="how">
                Mount <code>{{ data.host }}:{{ data.share?.mountpoint ?? '…' }}</code>
              </p>
            </div>
          }
        </section>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </form>
      <div mkDialogFooter class="footer">
        @if (data.share) {
          <button mkButton variant="ghost" tone="danger" type="button" [loading]="busy()" (click)="unshare()">Stop sharing</button>
        }
        <span class="spacer"></span>
        <button mkButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button mkButton type="submit" form="share-form" [loading]="busy()" [disabled]="!valid() || loadingAccess()">
          {{ data.share ? 'Save' : 'Share' }}
        </button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-4);
      }
      .proto {
        display: grid;
        gap: var(--mk-space-2);
      }
      .sub {
        margin-left: calc(var(--mk-space-6) + 2px);
        display: grid;
        gap: var(--mk-space-2);
      }
      h3 {
        font-size: var(--mk-font-size-sm);
        margin: var(--mk-space-2) 0 0;
      }
      .people {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
      }
      .person {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        padding: var(--mk-space-2) 0;
        border-top: 1px solid var(--mk-border-subtle);
      }
      .person__main {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .person__level {
        flex: 0 0 11rem;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .how {
        margin: 0;
        font-size: var(--mk-font-size-sm);
        color: var(--mk-text-muted);
      }
      code {
        font-family: var(--mk-font-mono);
        color: var(--mk-text);
      }
      .footer {
        display: flex;
        gap: var(--mk-space-2);
        width: 100%;
      }
      .spacer {
        flex: 1;
      }
      .warn {
        margin: 0;
        font-size: var(--mk-font-size-sm);
        color: var(--mk-warning);
      }
      .error {
        color: var(--mk-danger);
        margin: 0;
      }
    `,
  ],
})
export class ShareDialog {
  protected readonly data = inject<ShareDialogData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<Share | null | undefined>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  protected readonly name = this.data.dataset.split('/').pop();
  protected readonly smb = signal(this.data.share?.smb ?? true);
  protected readonly timeMachine = signal(this.data.share?.timeMachine ?? false);
  protected readonly nfs = signal(this.data.share?.nfs ?? false);
  protected readonly clients = signal(this.data.share?.nfsClients.join(', ') ?? '');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly valid = computed(() => this.smb() || this.nfs());
  protected readonly levels = LEVELS;
  /** One row per drive account; null until loaded. */
  protected readonly rows = signal<{ account: ShareAccessAccount; level: WritableSignal<Level> }[] | null>(null);
  protected readonly accessError = signal('');
  protected readonly loadingAccess = computed(() => this.smb() && this.rows() === null && !this.accessError());
  protected readonly nobody = computed(() => (this.rows() ?? []).every((r) => r.level() === 'none'));

  constructor() {
    // a share with a list shows it as saved; one without (new, or from an agent before lists) starts from the drive's grants
    const saved = this.data.share?.smbAccess;
    this.api.nas
      .shareAccess(this.data.dataset)
      .then((r) =>
        this.rows.set(
          r.accounts.map((account) => ({
            account,
            level: signal<Level>(saved ? (saved.find((a) => a.user === account.smbName)?.level ?? 'none') : (account.suggested ?? 'none')),
          })),
        ),
      )
      .catch((e) => this.accessError.set(errorMessage(e)));
  }

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const nfsClients = this.clients()
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const rows = this.rows();
      const s = await this.api.nas.setShare({
        dataset: this.data.dataset,
        smb: this.smb(),
        timeMachine: this.smb() && this.timeMachine(),
        nfs: this.nfs(),
        nfsClients,
        // exactly what the list shows; left out when SMB is off or the accounts did not load, which keeps the share's list
        ...(this.smb() && rows
          ? { smbAccess: rows.filter((r) => r.level() !== 'none').map((r) => ({ user: r.account.smbName, level: r.level() as SmbAccess['level'] })) }
          : {}),
      });
      this.ref.close(s);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async unshare(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.nas.removeShare(this.data.dataset);
      this.ref.close(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
