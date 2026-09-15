import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkDialog } from '@mk-kit/ui/feedback';
import { MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { DriveService } from '../core/drive.service';
import { FolderTree } from './folder-tree';

export interface FolderPickerData {
  title: string;
  confirmText: string;
  /** Starting folder (drive path). */
  start: string;
  /** Paths being moved: they and their descendants cannot be the destination. */
  moving?: string[];
}

/** Pick a destination folder in any writable location. */
@Component({
  selector: 'app-folder-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkSelect, FolderTree],
  template: `
    <mk-dialog [dialogTitle]="data.title">
      @if (locations().length > 1) {
        <mk-select [options]="locations()" [(value)]="location" aria-label="Location" class="loc" />
      }
      <div class="tree"><app-folder-tree [root]="treeRoot()" [current]="current()" (navigate)="current.set($event)" /></div>
      <p class="muted target">Into <strong>{{ current() }}</strong></p>
      <div mkDialogFooter class="footer">
        <button mkButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mkButton [disabled]="!valid()" (click)="ref.close(current())">{{ data.confirmText }}</button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      :host {
        display: block;
        width: min(520px, calc(100vw - 48px));
      }
      .loc {
        display: block;
        margin-bottom: var(--mk-space-3);
      }
      .tree {
        height: min(50vh, 380px);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-md);
        overflow: auto;
      }
      .target {
        margin: var(--mk-space-3) 0 0;
        font-size: var(--mk-font-size-sm);
        overflow-wrap: anywhere;
      }
      .footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--mk-space-2);
      }
    `,
  ],
})
export class FolderPickerDialog {
  protected readonly data = inject<FolderPickerData>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<string | undefined>>(MkOverlayRef);
  private readonly drive = inject(DriveService);
  protected readonly locations = computed<MkSelectOption[]>(() => this.drive.locations().filter((l) => l.access === 'write').map((l) => ({ label: l.name, value: l.name })));
  protected readonly location = signal(this.data.start.split('/')[0]);
  /** Follows the location (resetting to its root) but starts at `data.start`. */
  protected readonly current = linkedSignal<string, string>({ source: this.location, computation: (loc, prev) => (prev === undefined ? this.data.start : loc) });
  /** A folder reached through a share: the tree starts at the share, since the location itself is not visible. */
  protected readonly treeRoot = computed(() => (this.location() === this.data.start.split('/')[0] ? this.drive.sharedRootOf(this.data.start)?.path : undefined) ?? this.location());

  protected readonly valid = computed(() => {
    const target = this.current();
    for (const m of this.data.moving ?? []) {
      if (target === m || target.startsWith(m + '/')) return false;
      if (m.slice(0, m.lastIndexOf('/')) === target) return false; // already there
    }
    return true;
  });
}
