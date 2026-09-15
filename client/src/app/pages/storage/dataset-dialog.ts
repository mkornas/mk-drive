import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkFormField, MkNumberInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import type { Compression, Dataset } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { GIB } from './confirm';

export const COMPRESSIONS: MkSelectOption[] = [
  { label: 'lz4 — fast, the default', value: 'lz4' },
  { label: 'zstd — smaller, a little slower', value: 'zstd' },
  { label: 'gzip — smallest, slow', value: 'gzip' },
  { label: 'off', value: 'off' },
];

/** Quota, compression and atime of an existing dataset. */
@Component({
  selector: 'app-dataset-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkFormField, MkNumberInput, MkSelect, MkCheckbox],
  template: `
    <mk-dialog [dialogTitle]="'Settings of ' + data.name">
      <form class="form" id="dataset-form" (submit)="save($event)">
        <mk-form-field label="Quota (GiB)" hint="Empty = no limit">
          <mk-number-input [(value)]="quota" [min]="1" [step]="1" />
        </mk-form-field>
        <mk-form-field label="Compression">
          <mk-select [options]="compressions" [(value)]="compression" />
        </mk-form-field>
        <mk-checkbox [(checked)]="atime">Record access times (atime) — off is faster and the usual choice</mk-checkbox>
        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </form>
      <div mkDialogFooter class="footer">
        <button mkButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button mkButton type="submit" form="dataset-form" [loading]="busy()">Save</button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: var(--mk-space-3);
      }
      .error {
        color: var(--mk-danger);
        margin: 0;
      }
    `,
  ],
})
export class DatasetDialog {
  protected readonly data = inject<Dataset>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<Dataset | undefined>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  protected readonly compressions = COMPRESSIONS;
  protected readonly quota = signal<number | null>(this.data.quota ? Math.round(this.data.quota / GIB) : null);
  protected readonly compression = signal<Compression>((this.data.compression as Compression) ?? 'lz4');
  protected readonly atime = signal(this.data.atime);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    this.busy.set(true);
    this.error.set('');
    try {
      const q = this.quota();
      const ds = await this.api.nas.setDataset({ dataset: this.data.name, quota: q ? q * GIB : null, compression: this.compression(), atime: this.atime() });
      this.ref.close(ds);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
