import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkFormField, MkNumberInput } from '@mk-kit/ui/forms';
import type { Policy } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';

export interface PolicyDialogData {
  dataset: string;
  policy: Policy | null;
}

/** How many automatic snapshots to keep per period; all zeros switches the policy off. */
@Component({
  selector: 'app-policy-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkFormField, MkNumberInput],
  template: `
    <mk-dialog [dialogTitle]="'Snapshots of ' + data.dataset">
      <p class="muted">
        A timer on the NAS takes a snapshot when one is due and keeps the newest of each kind. Manual snapshots are never touched. All zeros switches it off.
      </p>
      <form class="form" id="policy-form" (submit)="save($event)">
        <div class="grid">
          <mk-form-field label="Hourly" hint="24 = one day back, hour by hour"
            ><mk-number-input [(value)]="hourly" [min]="0" [max]="1000" [step]="1"
          /></mk-form-field>
          <mk-form-field label="Daily" hint="7 = a week"><mk-number-input [(value)]="daily" [min]="0" [max]="1000" [step]="1" /></mk-form-field>
          <mk-form-field label="Weekly" hint="4 = a month"><mk-number-input [(value)]="weekly" [min]="0" [max]="1000" [step]="1" /></mk-form-field>
          <mk-form-field label="Monthly" hint="12 = a year"><mk-number-input [(value)]="monthly" [min]="0" [max]="1000" [step]="1" /></mk-form-field>
        </div>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </form>
      <div mkDialogFooter class="footer">
        <button mkButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button mkButton type="submit" form="policy-form" [loading]="busy()">Save</button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-3);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
        gap: var(--mk-space-3);
      }
      .error {
        color: var(--mk-danger);
        margin: 0;
      }
    `,
  ],
})
export class PolicyDialog {
  protected readonly data = inject<PolicyDialogData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<Policy | null | undefined>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  protected readonly hourly = signal<number | null>(this.data.policy?.hourly ?? 24);
  protected readonly daily = signal<number | null>(this.data.policy?.daily ?? 7);
  protected readonly weekly = signal<number | null>(this.data.policy?.weekly ?? 4);
  protected readonly monthly = signal<number | null>(this.data.policy?.monthly ?? 3);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    this.busy.set(true);
    this.error.set('');
    try {
      const args = {
        dataset: this.data.dataset,
        hourly: this.hourly() ?? 0,
        daily: this.daily() ?? 0,
        weekly: this.weekly() ?? 0,
        monthly: this.monthly() ?? 0,
      };
      const p = await this.api.nas.setPolicy(args);
      this.ref.close(args.hourly + args.daily + args.weekly + args.monthly === 0 ? null : p);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
