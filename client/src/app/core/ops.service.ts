import { Injectable, inject } from '@angular/core';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import type { ConflictPolicy, OpResult } from '../../../../shared/types';
import { ApiService, errorMessage } from './api.service';
import { ConflictDialog, type ConflictChoice, type ConflictDialogData } from '../shared/conflict-dialog';
import { FolderPickerDialog, type FolderPickerData } from '../shared/folder-picker-dialog';

/** Move / copy / delete with the conflict conversation, shared by the browse page and drag-and-drop. */
@Injectable({ providedIn: 'root' })
export class OpsService {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);

  pickFolder(data: FolderPickerData): Promise<string | undefined> {
    return this.dialog.open<FolderPickerDialog, string | undefined, FolderPickerData>(FolderPickerDialog, { data, size: 'md' }).afterClosed;
  }

  askConflict(names: string[], verb: string): Promise<ConflictChoice | undefined> {
    return this.dialog.open<ConflictDialog, ConflictChoice | undefined, ConflictDialogData>(ConflictDialog, { data: { names, verb } }).afterClosed;
  }

  /** Run a batch op; on taken names ask once, then retry those with the chosen policy. Returns the successful results. */
  async transfer(kind: 'move' | 'copy', paths: string[], to: string): Promise<OpResult[]> {
    const run = (ps: string[], policy: ConflictPolicy) => (kind === 'move' ? this.api.move(ps, to, policy) : this.api.copy(ps, to, policy));
    let results: OpResult[];
    try {
      results = await run(paths, 'fail');
    } catch (e) {
      this.toast.danger(errorMessage(e));
      return [];
    }
    const taken = results.filter((r) => r.code === 'exists');
    if (taken.length) {
      const choice = await this.askConflict(
        taken.map((r) => r.from.split('/').pop()!),
        kind,
      );
      if (choice && choice.policy !== 'skip') {
        const retry = await run(taken.map((r) => r.from), choice.policy);
        results = results.map((r) => (r.code === 'exists' ? (retry.find((x) => x.from === r.from) ?? r) : r));
      }
    }
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok && r.code !== 'exists');
    if (failed.length) this.toast.danger(failed.map((r) => `${r.from.split('/').pop()}: ${r.error}`).join('\n'), { title: `${failed.length} could not be ${kind === 'move' ? 'moved' : 'copied'}` });
    else if (ok.length) this.toast.success(`${ok.length === 1 ? ok[0].to!.split('/').pop() : ok.length + ' items'} ${kind === 'move' ? 'moved' : 'copied'} to ${to.split('/').pop()}`);
    return ok;
  }

  /** Delete to the trash with an undo toast. `onUndo` runs after a successful restore. */
  async delete(paths: string[], onUndo: () => void): Promise<OpResult[]> {
    let results: OpResult[];
    try {
      results = await this.api.deleteEntries(paths);
    } catch (e) {
      this.toast.danger(errorMessage(e));
      return [];
    }
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) this.toast.danger(failed.map((r) => `${r.from.split('/').pop()}: ${r.error}`).join('\n'), { title: `${failed.length} could not be deleted` });
    if (ok.length) {
      const label = ok.length === 1 ? `“${ok[0].from.split('/').pop()}”` : `${ok.length} items`;
      this.toast.info(`${label} moved to the trash`, {
        duration: 8000,
        action: {
          label: 'Undo',
          handler: async () => {
            for (const r of ok) await this.api.restore(r.to!, 'rename').catch(() => {});
            onUndo();
          },
        },
      });
    }
    return ok;
  }
}
