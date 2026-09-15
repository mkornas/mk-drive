import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput } from '@mk-kit/ui/forms';
import type { Share } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';

export interface ShareDialogData {
  dataset: string;
  share: Share | null;
  host: string;
}

/** Hand a dataset out over the network, or take it back: SMB for Finder and Explorer (and Time Machine), NFS for other machines. */
@Component({
  selector: 'app-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkCheckbox, MkFormField, MkInput],
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
              @if (canConnect(); as who) {
                @if (who.length === 0) {
                  <p class="warn">
                    Nobody can connect over SMB yet — set an SMB password under Settings → Account → Network access. A login on the box itself is not an SMB
                    account.
                  </p>
                } @else {
                  <p class="how">Who can connect: {{ who.join(', ') }}</p>
                }
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
        <button mkButton type="submit" form="share-form" [loading]="busy()" [disabled]="!smb() && !nfs()">{{ data.share ? 'Save' : 'Share' }}</button>
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
  /** Users with an SMB password; null until loaded (or when the list could not be read — then the dialog says nothing). */
  protected readonly canConnect = signal<string[] | null>(null);

  constructor() {
    this.api.nas
      .users()
      .then((users) => this.canConnect.set(users.filter((u) => u.hasPassword).map((u) => u.name)))
      .catch(() => undefined);
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
      const s = await this.api.nas.setShare({
        dataset: this.data.dataset,
        smb: this.smb(),
        timeMachine: this.smb() && this.timeMachine(),
        nfs: this.nfs(),
        nfsClients,
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
