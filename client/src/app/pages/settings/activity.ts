import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkTag } from '@mk-kit/ui/data';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import type { AuditEntry } from '../../../../../shared/types';
import { ApiService } from '../../core/api.service';
import { dateTime } from '../../core/format';
import { SettingsShell } from './shell';

const LABELS: Record<string, string> = {
  setup: 'created the first account',
  login: 'signed in',
  'login.failed': 'failed to sign in',
  'session.revoke': 'signed out a device',
  'session.revoke-others': 'signed out other devices',
  'token.create': 'made an app password',
  'token.revoke': 'removed an app password',
  'share.user': 'shared a folder with someone',
  'share.user.remove': 'stopped sharing a folder',
  'password.change': 'changed their password',
  'password.reset': 'had their password reset',
  'connector.add': 'added a location',
  'connector.remove': 'removed a location',
  'user.create': 'added a person',
  'user.update': 'changed a person',
  'user.delete': 'removed a person',
  mkdir: 'created a folder',
  rename: 'renamed',
  move: 'moved',
  copy: 'copied',
  delete: 'moved to the trash',
  restore: 'restored from the trash',
  purge: 'deleted for good',
  'trash.empty': 'emptied the trash',
  upload: 'uploaded',
  edit: 'edited',
  zip: 'downloaded a zip',
  'share.create': 'created a link',
  'share.delete': 'removed a link',
  'restore.version': 'restored an earlier version',
};

@Component({
  selector: 'app-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkTable, MkTableCell, MkTag, MkEmptyState, MkSpinner],
  template: `
    <app-settings heading="Activity" description="Who did what on this drive: sign-ins, account changes, and every change to a file.">
      @if (rows() === null) {
        <mk-spinner />
      } @else if (rows()!.length === 0) {
        <mk-empty-state icon="history" title="Nothing yet" />
      } @else {
        <mk-table [columns]="columns" [data]="rows()!" trackKey="id" density="compact" [stackAt]="600">
          <ng-template mkTableCell="at" let-value><span class="nowrap muted">{{ f.dateTime(value) }}</span></ng-template>
          <ng-template mkTableCell="action" let-row="row">
            <span><strong>{{ row.email }}</strong> {{ label(row.action) }}</span>
            @if (row.action === 'login.failed') {<mk-tag size="sm" tone="warning">failed</mk-tag>}
          </ng-template>
          <ng-template mkTableCell="detail" let-row="row"><span class="mono muted small">{{ row.path || row.detail }}</span></ng-template>
        </mk-table>
        @if (more()) {
          <div class="foot"><button mkButton variant="ghost" [loading]="loading()" (click)="older()">Show older</button></div>
        }
      }
    </app-settings>
  `,
  styles: [
    `
      .small {
        font-size: var(--mk-font-size-xs);
        overflow-wrap: anywhere;
      }
      .foot {
        margin-top: var(--mk-space-3);
      }
    `,
  ],
})
export class ActivityPage {
  private readonly api = inject(ApiService);
  protected readonly rows = signal<AuditEntry[] | null>(null);
  protected readonly more = signal(false);
  protected readonly loading = signal(false);
  protected readonly f = { dateTime };
  protected readonly columns: MkTableColumn<AuditEntry>[] = [
    { key: 'at', header: 'When', width: '170px' },
    { key: 'action', header: 'What', stack: 'title' },
    { key: 'detail', header: 'Detail' },
  ];

  constructor() {
    void this.older();
  }

  label(action: string): string {
    return LABELS[action] ?? action;
  }

  async older(): Promise<void> {
    this.loading.set(true);
    try {
      const current = this.rows() ?? [];
      const before = current.length ? current[current.length - 1].id : undefined;
      const batch = await this.api.audit(100, before);
      this.rows.set([...current, ...batch]);
      this.more.set(batch.length === 100);
    } finally {
      this.loading.set(false);
    }
  }
}
