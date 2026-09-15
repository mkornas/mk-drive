import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkProgressBar } from '@mk-kit/ui/data';
import { bytes } from '../core/format';
import { type UploadJob, UploaderService } from '../core/uploader.service';

/** The upload queue, pinned bottom-right; stays while you browse elsewhere. */
@Component({
  selector: 'app-upload-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkProgressBar],
  template: `
    @if (up.open() && up.jobs().length) {
      <section class="panel" aria-label="Uploads">
        <header class="head">
          <strong>{{ title() }}</strong>
          <span class="spacer"></span>
          <button mkButton variant="ghost" size="sm" iconOnly aria-label="Clear finished" (click)="up.clearFinished()"><mk-icon name="close" size="sm" /></button>
        </header>
        <mk-progress-bar [value]="overall()" size="sm" [indeterminate]="false" />
        <ul class="list">
          @for (j of recent(); track j.id) {
            <li class="job" [class.job--bad]="j.state === 'failed'">
              <mk-icon [name]="icon(j)" size="sm" class="job__icon" />
              <span class="job__name" [title]="j.dir + '/' + j.name">{{ j.name }}</span>
              <span class="muted job__meta">{{ meta(j) }}</span>
              @if (j.state === 'uploading' || j.state === 'queued') {
                <button mkButton variant="ghost" size="sm" iconOnly aria-label="Cancel" (click)="up.cancel(j)"><mk-icon name="close" size="sm" /></button>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [
    `
      .panel {
        position: fixed;
        right: var(--mk-space-4);
        bottom: var(--mk-space-4);
        width: min(380px, calc(100vw - 32px));
        background: var(--mk-surface);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        box-shadow: var(--mk-shadow-lg);
        z-index: var(--mk-z-toast);
        overflow: hidden;
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        padding: var(--mk-space-3) var(--mk-space-3) var(--mk-space-2) var(--mk-space-4);
      }
      .spacer {
        flex: 1;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: var(--mk-space-2) var(--mk-space-2) var(--mk-space-2) var(--mk-space-4);
        max-height: 40vh;
        overflow: auto;
        display: grid;
        gap: 2px;
      }
      .job {
        display: grid;
        grid-template-columns: auto 1fr auto auto;
        align-items: center;
        gap: var(--mk-space-2);
        font-size: var(--mk-font-size-sm);
        min-height: 32px;
      }
      .job__icon {
        color: var(--mk-text-muted);
      }
      .job--bad .job__icon {
        color: var(--mk-danger);
      }
      .job__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .job__meta {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
    `,
  ],
})
export class UploadPanel {
  protected readonly up = inject(UploaderService);
  protected readonly recent = computed(() => this.up.jobs().slice(-12).reverse());
  protected readonly overall = computed(() => {
    const jobs = this.up.jobs().filter((j) => j.state !== 'cancelled' && j.state !== 'skipped');
    const total = jobs.reduce((n, j) => n + j.file.size, 0);
    const sent = jobs.reduce((n, j) => n + (j.state === 'done' ? j.file.size : j.sent), 0);
    return total ? Math.round((sent / total) * 100) : 100;
  });
  protected readonly title = computed(() => {
    const active = this.up.active().length;
    const failed = this.up.jobs().filter((j) => j.state === 'failed').length;
    if (active) return `Uploading ${active} file${active === 1 ? '' : 's'}`;
    if (failed) return `${failed} upload${failed === 1 ? '' : 's'} failed`;
    return 'Uploads finished';
  });

  icon(j: UploadJob): string {
    return j.state === 'done' ? 'circle-check' : j.state === 'failed' ? 'circle-alert' : j.state === 'cancelled' ? 'circle-x' : 'upload';
  }

  meta(j: UploadJob): string {
    if (j.state === 'done') return bytes(j.file.size, 0);
    if (j.state === 'failed') return j.error ?? 'failed';
    if (j.state === 'cancelled') return 'cancelled';
    if (j.state === 'queued') return 'waiting';
    return `${bytes(j.sent, 0)} / ${bytes(j.file.size, 0)}`;
  }
}
