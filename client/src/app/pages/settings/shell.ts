import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MkIcon } from '@mk-kit/ui/icon';
import { DriveService } from '../../core/drive.service';

interface Tab {
  label: string;
  path: string;
  icon: string;
  admin?: boolean;
}

const TABS: Tab[] = [
  { label: 'Account', path: '/settings/account', icon: 'user' },
  { label: 'Devices', path: '/settings/devices', icon: 'smartphone' },
  { label: 'Connect', path: '/settings/connect', icon: 'plug' },
  { label: 'Links', path: '/settings/links', icon: 'link' },
  { label: 'People', path: '/settings/people', icon: 'users', admin: true },
  { label: 'Locations', path: '/settings/locations', icon: 'hard-drive', admin: true },
  { label: 'Activity', path: '/settings/activity', icon: 'history', admin: true },
];

/** Settings pages share a heading and the row of section links. */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MkIcon],
  template: `
    <div class="page page--narrow">
      <nav class="tabs" aria-label="Settings sections">
        @for (t of tabs(); track t.path) {
          <a [routerLink]="t.path" class="tab" [class.tab--active]="active() === t.path" [attr.aria-current]="active() === t.path ? 'page' : null"><mk-icon [name]="t.icon" size="sm" />{{ t.label }}</a>
        }
      </nav>
      <header class="head">
        <h1>{{ heading() }}</h1>
        @if (description()) {
          <p class="muted">{{ description() }}</p>
        }
      </header>
      <ng-content />
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
    `,
  ],
})
export class SettingsShell {
  private readonly drive = inject(DriveService);
  private readonly router = inject(Router);
  readonly heading = input.required<string>();
  readonly description = input('');
  protected readonly tabs = computed(() => TABS.filter((t) => !t.admin || this.drive.isAdmin()));
  protected readonly active = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.split('?')[0]),
    ),
    { initialValue: this.router.url.split('?')[0] },
  );
}
