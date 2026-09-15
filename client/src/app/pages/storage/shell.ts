import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkAlert } from '@mk-kit/ui/feedback';
import { MkSpinner } from '@mk-kit/ui/status';

const TABS = [
  { label: 'Overview', path: '/storage/overview', icon: 'activity' },
  { label: 'Disks', path: '/storage/disks', icon: 'hard-drive' },
  { label: 'Pools', path: '/storage/pools', icon: 'database' },
  { label: 'Datasets', path: '/storage/datasets', icon: 'layers' },
  { label: 'Snapshots', path: '/storage/snapshots', icon: 'camera' },
  { label: 'Shares', path: '/storage/shares', icon: 'globe' },
  { label: 'Copies', path: '/storage/replication', icon: 'copy' },
  { label: 'Network', path: '/storage/network', icon: 'wifi' },
];

/**
 * Storage pages (NAS mode) share the row of section links, a heading, and
 * the three states every page has: loading, the agent's error, content.
 * The page gives `loading` and `error`; the shell draws them.
 */
@Component({
  selector: 'app-storage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MkIcon, MkButton, MkAlert, MkSpinner],
  template: `
    <div class="page">
      <nav class="tabs" aria-label="Storage sections">
        @for (t of tabs; track t.path) {
          <a [routerLink]="t.path" class="tab" [class.tab--active]="active() === t.path" [attr.aria-current]="active() === t.path ? 'page' : null"
            ><mk-icon [name]="t.icon" size="sm" />{{ t.label }}</a
          >
        }
      </nav>
      <header class="head">
        <div>
          <h1>{{ heading() }}</h1>
          @if (description()) {
            <p class="muted">{{ description() }}</p>
          }
        </div>
        <button mkButton variant="ghost" size="sm" [loading]="loading()" (click)="refresh.emit()" aria-label="Refresh">
          <mk-icon name="refresh-cw" size="sm" /> Refresh
        </button>
      </header>
      @if (error(); as err) {
        <mk-alert tone="danger" title="The NAS agent did not answer" class="alert">{{ err }}</mk-alert>
      } @else if (loading() && !loaded()) {
        <mk-spinner />
      }
      @if (loaded()) {
        <ng-content />
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .tabs {
        display: flex;
        gap: var(--mk-space-1);
        flex-wrap: wrap;
        margin-bottom: var(--mk-space-6);
      }
      .tab {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
        padding: 6px 12px;
        border-radius: var(--mk-radius-pill);
        color: var(--mk-text-muted);
        text-decoration: none;
        font-size: var(--mk-font-size-sm);
        font-weight: 500;
      }
      .tab:hover {
        background: var(--mk-hover-overlay);
        color: var(--mk-text);
      }
      .tab--active {
        background: var(--mk-primary-subtle);
        color: var(--mk-primary-subtle-text);
      }
      .tab:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
        outline-offset: var(--mk-focus-ring-offset);
      }
      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--mk-space-4);
        margin-bottom: var(--mk-space-6);
      }
      .head h1 {
        font-size: var(--mk-font-size-2xl);
        margin: 0 0 var(--mk-space-1);
      }
      .head p {
        margin: 0;
        max-width: 60ch;
      }
      .alert {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
    `,
  ],
})
export class StorageShell {
  private readonly router = inject(Router);
  readonly heading = input.required<string>();
  readonly description = input('');
  readonly loading = input(false);
  /** The page has data to show (stays true across refreshes so the content does not blink). */
  readonly loaded = input(false);
  readonly error = input<string | null>(null);
  readonly refresh = output<void>();
  protected readonly tabs = TABS;
  protected readonly active = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.split('?')[0]),
    ),
    { initialValue: this.router.url.split('?')[0] },
  );
}
