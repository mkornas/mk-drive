import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkNumberInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import type { Replication, ReplicationSchedule } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';

export interface ReplicationDialogData {
  replication: Replication | null;
  datasets: string[];
}

const SCHEDULES: MkSelectOption[] = [
  { label: 'Every hour', value: 'hourly' },
  { label: 'Every day', value: 'daily' },
  { label: 'Every week', value: 'weekly' },
  { label: 'Only when I run it', value: 'manual' },
];

/** Where a dataset goes, how often, and a test button that tells the truth about the target before anything is saved. */
@Component({
  selector: 'app-replication-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkCheckbox, MkFormField, MkInput, MkNumberInput, MkSelect, MkIcon],
  template: `
    <mk-dialog [dialogTitle]="data.replication ? 'Change the copy of ' + data.replication.dataset : 'Copy a dataset to another machine'">
      <form class="form" id="repl-form" (submit)="save($event)">
        <mk-form-field label="Dataset"><mk-select [options]="datasets" [(value)]="dataset" placeholder="Pick one" /></mk-form-field>
        <div class="row">
          <mk-form-field label="Host" hint="Name or address of the other machine"
            ><input mkInput [value]="host()" (input)="host.set($any($event.target).value)" placeholder="truenas" required autocomplete="off"
          /></mk-form-field>
          <mk-form-field label="User" hint="root, or a user allowed to receive"
            ><input mkInput [value]="user()" (input)="user.set($any($event.target).value)" placeholder="root" autocomplete="off"
          /></mk-form-field>
          <mk-form-field label="Port"><mk-number-input [(value)]="port" [min]="1" [max]="65535" [step]="1" /></mk-form-field>
        </div>
        <mk-form-field label="Dataset on the other machine" hint="Created by the first send if it does not exist; its parent must"
          ><input
            mkInput
            [value]="targetDataset()"
            (input)="targetDataset.set($any($event.target).value)"
            placeholder="backup/photos"
            required
            autocomplete="off"
        /></mk-form-field>
        <div class="test">
          <button mkButton variant="ghost" type="button" [loading]="testing()" [disabled]="!host() || !targetDataset()" (click)="test()">
            <mk-icon name="link" size="sm" /> Test the connection
          </button>
          @if (testResult(); as t) {
            <span [class.ok]="t.ok" [class.bad]="!t.ok">{{ t.message }}</span>
          }
        </div>
        <div class="row">
          <mk-form-field label="How often"><mk-select [options]="schedules" [(value)]="schedule" /></mk-form-field>
          <mk-form-field label="Snapshots to keep" hint="Of the ones the copy makes, on both sides"
            ><mk-number-input [(value)]="keep" [min]="1" [max]="100" [step]="1"
          /></mk-form-field>
        </div>
        <mk-checkbox [(checked)]="recursive">Include the datasets inside it</mk-checkbox>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </form>
      <div mkDialogFooter class="footer">
        <button mkButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button mkButton type="submit" form="repl-form" [loading]="busy()" [disabled]="!valid()">{{ data.replication ? 'Save' : 'Add the copy' }}</button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-3);
      }
      .row {
        display: grid;
        grid-template-columns: 2fr 1fr 1fr;
        gap: var(--mk-space-3);
      }
      .row:has(> :nth-child(2):last-child) {
        grid-template-columns: 1fr 1fr;
      }
      .test {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
        font-size: var(--mk-font-size-sm);
      }
      .ok {
        color: var(--mk-success);
      }
      .bad {
        color: var(--mk-danger);
      }
      .error {
        color: var(--mk-danger);
        margin: 0;
      }
      @media (max-width: 560px) {
        .row {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class ReplicationDialog {
  protected readonly data = inject<ReplicationDialogData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<Replication | undefined>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  protected readonly schedules = SCHEDULES;
  protected readonly datasets: MkSelectOption[] = this.data.datasets.map((d) => ({ label: d, value: d }));
  protected readonly dataset = signal(this.data.replication?.dataset ?? this.data.datasets[0] ?? '');
  protected readonly host = signal(this.data.replication?.host ?? '');
  protected readonly user = signal(this.data.replication?.user ?? 'root');
  protected readonly port = signal<number | null>(this.data.replication?.port ?? 22);
  protected readonly targetDataset = signal(this.data.replication?.targetDataset ?? '');
  protected readonly schedule = signal<ReplicationSchedule>(this.data.replication?.schedule ?? 'daily');
  protected readonly keep = signal<number | null>(this.data.replication?.keep ?? 3);
  protected readonly recursive = signal(this.data.replication?.recursive ?? false);
  protected readonly busy = signal(false);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly error = signal('');
  protected readonly valid = computed(
    () =>
      !!this.dataset() &&
      /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(this.host()) &&
      /^[A-Za-z][A-Za-z0-9_.:-]*(\/[A-Za-z0-9][A-Za-z0-9_.:-]*)*$/.test(this.targetDataset()),
  );

  async test(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      this.testResult.set(
        await this.api.nas.testReplication({
          host: this.host().trim(),
          user: this.user().trim() || 'root',
          port: this.port() ?? 22,
          targetDataset: this.targetDataset().trim(),
        }),
      );
    } catch (e) {
      this.testResult.set({ ok: false, message: errorMessage(e) });
    } finally {
      this.testing.set(false);
    }
  }

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.nas.setReplication({
        ...(this.data.replication ? { id: this.data.replication.id } : {}),
        dataset: this.dataset(),
        host: this.host().trim(),
        user: this.user().trim() || 'root',
        port: this.port() ?? 22,
        targetDataset: this.targetDataset().trim(),
        schedule: this.schedule(),
        keep: this.keep() ?? 3,
        recursive: this.recursive(),
      });
      this.ref.close(r);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
