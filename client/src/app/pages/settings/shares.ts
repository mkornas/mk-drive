import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTag } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import { MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import type { Share } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { ago, dateTime } from '../../core/format';
import { SettingsShell } from './shell';

@Component({
  selector: 'app-shares',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkIcon, MkTag, MkEmptyState, MkSpinner, MkTooltip],
  template: `
    <app-settings heading="Links" [description]="drive.isAdmin() ? 'Every public link on this drive. Remove one and it stops working immediately.' : 'Public links you created. Remove one and it stops working immediately.'">
      @if (shares() === null) {
        <mk-spinner />
      } @else if (shares()!.length === 0) {
        <mk-empty-state icon="link" title="No links yet" description="Select a file or folder and choose Share to create one." />
      } @else {
        <ul class="list">
          @for (s of shares(); track s.id) {
            <li class="item" [class.item--dead]="s.expiresAt && s.expiresAt < now">
              <mk-icon [name]="s.kind === 'dir' ? 'folder' : 'file'" class="item__icon" />
              <div class="item__main">
                <div class="item__title"><a class="plain" [href]="'/d/' + encode(s.path)" (click)="open($event, s)">{{ s.name }}</a>
                  @if (s.locked) {<mk-tag size="sm">password</mk-tag>}
                  @if (s.kind === 'dir') {<mk-tag size="sm" tone="neutral">{{ s.mode === 'browse' ? 'browse' : s.mode === 'upload' ? 'file request' : 'zip only' }}</mk-tag>}
                  @if (s.expiresAt && s.expiresAt < now) {<mk-tag size="sm" tone="danger">expired</mk-tag>}
                </div>
                <div class="muted item__meta">{{ s.path }} · {{ s.expiresAt ? 'expires ' + f.dateTime(s.expiresAt) : 'no expiry' }} · opened {{ s.hits }}×@if (drive.isAdmin()) { · by {{ s.createdBy }}}</div>
              </div>
              <button mkButton variant="ghost" size="sm" iconOnly aria-label="Copy link" mkTooltip="Copy link" (click)="copy(s)"><mk-icon name="copy" size="sm" /></button>
              <button mkButton variant="ghost" size="sm" iconOnly tone="danger" aria-label="Remove link" mkTooltip="Remove link" (click)="remove(s)"><mk-icon name="link-off" size="sm" /></button>
            </li>
          }
        </ul>
      }
    </app-settings>
  `,
  styles: [
    `
      .list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: var(--mk-space-2);
      }
      .item {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        padding: var(--mk-space-3) var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
      }
      .item--dead {
        opacity: 0.6;
      }
      .item__icon {
        color: var(--mk-text-muted);
      }
      .item__main {
        flex: 1;
        min-width: 0;
      }
      .item__title {
        font-weight: 500;
        display: flex;
        gap: var(--mk-space-2);
        align-items: center;
        flex-wrap: wrap;
      }
      .item__meta {
        font-size: var(--mk-font-size-sm);
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class SharesPage {
  protected readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  private readonly router = inject(Router);
  protected readonly f = { ago, dateTime };
  protected readonly now = Date.now();
  protected readonly shares = signal<Share[] | null>(null);

  constructor() {
    void this.drive.ready().then(() => this.api.shares().then((s) => this.shares.set(s)));
  }

  encode(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  open(ev: Event, s: Share): void {
    ev.preventDefault();
    const target = s.kind === 'dir' ? s.path : s.path.slice(0, s.path.lastIndexOf('/'));
    void this.router.navigate(['/d', ...target.split('/')], s.kind === 'file' ? { queryParams: { open: s.name } } : {});
  }

  async copy(s: Share): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.api.shareLink(s.id));
      this.toast.success('Link copied');
    } catch {
      this.toast.warning(this.api.shareLink(s.id), { title: 'Copy this link by hand' });
    }
  }

  async remove(s: Share): Promise<void> {
    if (!(await this.dialog.confirm({ title: `Remove the link to “${s.name}”?`, message: 'Anyone who has it loses access right away.', confirmText: 'Remove link', tone: 'danger' }))) return;
    try {
      await this.api.deleteShare(s.id);
      this.shares.update((l) => l?.filter((x) => x.id !== s.id) ?? null);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
