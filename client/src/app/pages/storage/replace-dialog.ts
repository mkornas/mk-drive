import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import type { Disk, Pool } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { bytes } from '../../core/format';

export interface ReplaceDialogData {
  pool: Pool;
  /** The member as zpool status names it (a disk id, or a guid when the disk is gone). */
  member: string;
  memberState: string;
  free: Disk[];
}

/** A failed member out, a free disk in; the pool name typed; the resilver runs on its own afterwards. */
@Component({
  selector: 'app-replace-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkFormField, MkInput, MkSelect],
  template: `
    <mk-dialog [dialogTitle]="'Replace a disk in ' + data.pool.name">
      <p>
        <span class="mono">{{ data.member }}</span> is <strong>{{ data.memberState }}</strong
        >. Pick the disk that takes its place; the pool rebuilds onto it (a resilver) while it keeps working. The new disk must be at least as large.
      </p>
      <form class="form" id="replace-form" (submit)="save($event)">
        @if (data.free.length === 0) {
          <p class="warn">No free disk. Put one in, or wipe one on the Disks page.</p>
        } @else {
          <mk-form-field label="New disk"><mk-select [options]="options" [(value)]="disk" /></mk-form-field>
        }
        <mk-form-field label="Type the pool name to confirm"
          ><input mkInput [value]="confirm()" (input)="confirm.set($any($event.target).value)" [placeholder]="data.pool.name" autocomplete="off"
        /></mk-form-field>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </form>
      <div mkDialogFooter class="footer">
        <button mkButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button mkButton type="submit" form="replace-form" tone="danger" [loading]="busy()" [disabled]="!valid()">Replace and resilver</button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-3);
        margin-top: var(--mk-space-3);
      }
      .warn {
        color: var(--mk-warning);
        margin: 0;
      }
      .error {
        color: var(--mk-danger);
        margin: 0;
      }
    `,
  ],
})
export class ReplaceDialog {
  protected readonly data = inject<ReplaceDialogData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<Pool | undefined>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  protected readonly options: MkSelectOption[] = this.data.free.map((d) => ({ label: `${d.id} — ${d.model ?? '?'}, ${bytes(d.size, 0)}`, value: d.id }));
  protected readonly disk = signal(this.data.free[0]?.id ?? '');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly valid = computed(() => !!this.disk() && this.confirm() === this.data.pool.name);

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.ref.close(await this.api.nas.replaceDisk(this.data.pool.name, this.data.member, this.disk(), this.confirm()));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
