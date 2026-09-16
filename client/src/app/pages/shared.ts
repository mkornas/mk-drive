import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkEmptyState } from '@mk-kit/ui/status';
import { MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import { MkTag } from '@mk-kit/ui/data';
import { MkDrawer } from '@mk-kit/ui/navigation';
import type { Entry, UserShare } from '../../../../shared/types';
import { iconClass, iconFor } from '../core/file-kind';
import { Preview } from '../shared/preview';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { ago } from '../core/format';

interface Row {
  id: number;
  share: UserShare;
}

/** Folders other people on this drive opened up to the signed-in user. */
@Component({
  selector: 'app-shared',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkTable, MkTableCell, MkEmptyState, MkTooltip, MkTag, MkDrawer, Preview],
  template: `
    <div class="page">
      <header class="head">
        <div>
          <h1><mk-icon name="users" /> Shared with me</h1>
          <p class="muted">Folders and files other people on this drive let you into.</p>
        </div>
      </header>
      @if (rows().length === 0) {
        <mk-empty-state icon="users" title="Nothing shared with you yet" description="When someone shares a folder or a file with your account, it shows up here." />
      } @else {
        <mk-table [columns]="columns" [data]="rows()" trackKey="id" density="compact" [stackAt]="640" [clickableRows]="true" (rowClick)="open($event)">
          <ng-template mkTableCell="name" let-row="row">
            <span class="name"><mk-icon [name]="icon(row.share)" size="sm" [class]="tone(row.share)" /> {{ row.share.name }}</span>
          </ng-template>
          <ng-template mkTableCell="from" let-row="row"
            ><span class="muted">{{ row.share.owner.name }}</span></ng-template
          >
          <ng-template mkTableCell="level" let-row="row"
            ><mk-tag size="sm" [tone]="row.share.level === 'write' ? 'primary' : 'neutral'">{{
              row.share.level === 'write' ? 'can edit' : 'can view'
            }}</mk-tag></ng-template
          >
          <ng-template mkTableCell="at" let-row="row"
            ><span class="muted nowrap">{{ f.ago(row.share.createdAt) }}</span></ng-template
          >
          <ng-template mkTableCell="actions" let-row="row">
            @if (row.share.kind === 'file') {
              <a mkButton size="sm" variant="ghost" iconOnly [href]="api.fileUrl(row.share.path, true)" download aria-label="Download" mkTooltip="Download" (click)="$event.stopPropagation()"><mk-icon name="download" size="sm" /></a>
            }
            <button mkButton size="sm" variant="ghost" iconOnly tone="danger" aria-label="Leave" mkTooltip="Leave" (click)="$event.stopPropagation(); leave(row.share)"><mk-icon name="user-x" size="sm" /></button>
          </ng-template>
        </mk-table>
      }
    </div>

    <mk-drawer [(open)]="previewOpen" side="end" size="min(56rem, 100vw)" [heading]="previewEntry()?.name ?? ''">
      <app-preview [entry]="previewOpen() ? previewEntry() : null" />
    </mk-drawer>
  `,
  styles: [
    `
      .head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--mk-space-4);
        margin-bottom: var(--mk-space-5);
      }
      h1 {
        font-size: var(--mk-font-size-2xl);
        margin: 0 0 var(--mk-space-1);
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
      }
      p {
        margin: 0;
      }
      .name {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
      }
    `,
  ],
})
export class SharedPage {
  protected readonly drive = inject(DriveService);
  protected readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(MkToastService);
  protected readonly f = { ago };
  protected readonly previewOpen = signal(false);
  protected readonly previewEntry = signal<Entry | null>(null);
  protected readonly rows = computed<Row[]>(() => this.drive.shared().map((share) => ({ id: share.id, share })));
  protected readonly columns: MkTableColumn<Row>[] = [
    { key: 'name', header: 'Name', stack: 'title' },
    { key: 'from', header: 'From' },
    { key: 'level', header: 'Access', width: '110px' },
    { key: 'at', header: '', width: '120px' },
    { key: 'actions', header: '', width: '56px', align: 'end', stack: 'footer' },
  ];

  constructor() {
    void this.drive.ready().then(() => this.drive.refreshLocations().catch(() => {}));
  }

  /** A share row is not an entry, but it knows enough for the icon: what it is, its type and its name. */
  private asEntry(s: UserShare) {
    return { kind: s.kind === 'file' ? ('file' as const) : ('dir' as const), mime: s.mime ?? '', name: s.name };
  }

  icon(s: UserShare): string {
    return iconFor(this.asEntry(s));
  }

  tone(s: UserShare): string {
    return iconClass(this.asEntry(s));
  }

  /** A folder opens in the browser; a file has no visible parent, so it opens right here. */
  open(row: Row): void {
    const s = row.share;
    if (s.kind === 'file') {
      this.previewEntry.set({ name: s.name, path: s.path, kind: 'file', size: s.size ?? 0, mtime: s.mtime ?? 0, mime: s.mime ?? '', etag: '', hidden: false });
      this.previewOpen.set(true);
      return;
    }
    void this.router.navigate(['/d', ...s.path.split('/')]);
  }

  async leave(s: UserShare): Promise<void> {
    try {
      await this.api.removeUserShare(s.id);
      this.drive.shared.update((l) => l.filter((x) => x.id !== s.id));
      this.toast.success(`Left “${s.name}”`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
