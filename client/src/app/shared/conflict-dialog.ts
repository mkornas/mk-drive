import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import type { ConflictPolicy } from '../../../../shared/types';

export interface ConflictDialogData {
  /** The taken name(s). */
  names: string[];
  /** What is being done: "move", "copy", "upload", "restore". */
  verb: string;
}

export interface ConflictChoice {
  policy: ConflictPolicy | 'skip';
  all: boolean;
}

/** "That name is taken": replace it, keep both, or skip. */
@Component({
  selector: 'app-conflict-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkCheckbox],
  template: `
    <mk-dialog [dialogTitle]="data.names.length === 1 ? '“' + data.names[0] + '” already exists' : data.names.length + ' names already exist'">
      <p class="lead">Something with that name is already in the destination. What should the {{ data.verb }} do?</p>
      <div class="choices">
        <button mkButton variant="outline" fullWidth (click)="pick('rename')">Keep both <span class="muted">— the new one gets “(2)” added</span></button>
        <button mkButton variant="outline" fullWidth tone="danger" (click)="pick('replace')">Replace <span class="muted">— the existing one is overwritten</span></button>
        <button mkButton variant="outline" fullWidth (click)="pick('skip')">Skip <span class="muted">— leave it out</span></button>
      </div>
      @if (data.names.length > 1) {
        <label class="all"><mk-checkbox [(checked)]="all" /> Do this for all {{ data.names.length }}</label>
      }
      <div mkDialogFooter class="footer"><button mkButton variant="ghost" (click)="ref.close()">Cancel</button></div>
    </mk-dialog>
  `,
  styles: [
    `
      :host {
        display: block;
        width: min(460px, calc(100vw - 48px));
      }
      .lead {
        margin: 0 0 var(--mk-space-4);
        color: var(--mk-text-muted);
      }
      .choices {
        display: grid;
        gap: var(--mk-space-2);
      }
      .choices button {
        justify-content: flex-start;
        text-align: left;
      }
      .all {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        margin-top: var(--mk-space-4);
        font-size: var(--mk-font-size-sm);
      }
      .footer {
        display: flex;
        justify-content: flex-end;
      }
    `,
  ],
})
export class ConflictDialog {
  protected readonly data = inject<ConflictDialogData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<ConflictChoice | undefined>>(MkOverlayRef);
  protected readonly all = signal(true);

  pick(policy: ConflictPolicy | 'skip'): void {
    this.ref.close({ policy, all: this.data.names.length > 1 ? this.all() : true });
  }
}
