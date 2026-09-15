import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MkAccentService, MkThemeService } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkAvatar } from '@mk-kit/ui/data';
import { MkDialogService, MkToastContainer, MkToastService } from '@mk-kit/ui/feedback';
import { SwUpdate } from '@angular/service-worker';
import { MkAppShell, type MkCommand, MkCommandPalette, MkMenu, MkMenuItem, MkMenuTrigger, MkNavGroup, MkNavItem, MkNavList } from '@mk-kit/ui/navigation';
import { ApiService, errorMessage } from './core/api.service';
import { DriveService } from './core/drive.service';
import { bytes } from './core/format';
import { UploadPanel } from './shared/upload-panel';

interface SettingsLink {
  label: string;
  path: string;
  icon: string;
  admin?: boolean;
}

const STORAGE: SettingsLink[] = [
  { label: 'Overview', path: '/storage/overview', icon: 'activity' },
  { label: 'Disks', path: '/storage/disks', icon: 'hard-drive' },
  { label: 'Pools', path: '/storage/pools', icon: 'database' },
  { label: 'Datasets', path: '/storage/datasets', icon: 'layers' },
  { label: 'Snapshots', path: '/storage/snapshots', icon: 'camera' },
  { label: 'Shares', path: '/storage/shares', icon: 'globe' },
  { label: 'Copies', path: '/storage/replication', icon: 'copy' },
];

const SETTINGS: SettingsLink[] = [
  { label: 'Account', path: '/settings/account', icon: 'user' },
  { label: 'Devices', path: '/settings/devices', icon: 'smartphone' },
  { label: 'Connect', path: '/settings/connect', icon: 'plug' },
  { label: 'Links', path: '/settings/links', icon: 'link' },
  { label: 'People', path: '/settings/people', icon: 'users', admin: true },
  { label: 'Locations', path: '/settings/locations', icon: 'hard-drive', admin: true },
  { label: 'Sign-in', path: '/settings/sign-in', icon: 'key-round', admin: true },
  { label: 'Activity', path: '/settings/activity', icon: 'history', admin: true },
];

/** The frame: header with brand, theme toggle and account menu; sidebar with the locations and settings. */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    MkAppShell,
    MkNavList,
    MkNavGroup,
    MkNavItem,
    MkMenu,
    MkMenuItem,
    MkMenuTrigger,
    MkCommandPalette,
    MkButton,
    MkIcon,
    MkAvatar,
    MkToastContainer,
    UploadPanel,
  ],
  template: `
    @if (bare()) {
      <router-outlet />
    } @else {
      @if (drive.meta()?.nasOutdated; as o) {
        <div class="demo">
          This drive expects mk-nas contract {{ o.needs }}; the agent here is {{ o.agent }} (contract {{ o.contract }}). Storage pages may misbehave until
          mk-nas is upgraded: <code>sudo apt install ./mk-nas_*.deb</code> on the NAS.
        </div>
      }
      @if (drive.meta()?.demo) {
        <div class="demo">
          Demo drive — sample data, reset on every restart. Sign in as <strong>demo@example.com</strong> / <strong>demo-drive-2026</strong>.
        </div>
      }
      <mk-app-shell #shell [(sidebarCollapsed)]="collapsed">
        <div mkAppHeader class="hdr">
          <button
            mkButton
            variant="ghost"
            iconOnly
            class="hdr__menu"
            aria-label="Toggle navigation"
            (click)="shell.isMobile() ? shell.toggleSidebar() : shell.toggleCollapsed()"
          >
            <mk-icon name="menu" />
          </button>
          <a class="hdr__brand" href="/" (click)="go($event, '/')">
            <img class="hdr__logo" src="icon.svg" alt="" width="28" height="28" />
            <span class="hdr__name">{{ drive.name() }}</span>
          </a>
          <div class="hdr__spacer"></div>
          <button
            mkButton
            variant="ghost"
            iconOnly
            [attr.aria-label]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'"
            (click)="theme.toggle()"
          >
            <mk-icon [name]="theme.isDark() ? 'sun' : 'moon'" />
          </button>
          @if (drive.me(); as me) {
            <button class="who" [mkMenuTriggerFor]="userMenu" aria-label="Account menu">
              <mk-avatar [name]="me.name" size="sm" />
              <span class="who__name">{{ me.name }}</span>
            </button>
            <mk-menu #userMenu>
              @for (link of settingsLinks(); track link.path) {
                <mk-menu-item (action)="nav(link.path)"><mk-icon [name]="link.icon" size="sm" /> {{ link.label }}</mk-menu-item>
              }
              @if (drive.isAdmin()) {
                <mk-menu-item (action)="rename()"><mk-icon name="pencil" size="sm" /> Rename this drive…</mk-menu-item>
              }
              @if (me.via === 'session') {
                <mk-menu-item (action)="drive.signOut()"><mk-icon name="log-out" size="sm" /> Sign out</mk-menu-item>
              }
            </mk-menu>
          }
        </div>

        <mk-nav-list mkAppSidebar [collapsed]="collapsed()">
          @if (drive.locations().length) {
            <mk-nav-group label="Locations">
              @for (loc of drive.locations(); track loc.name) {
                <mk-nav-item
                  [label]="loc.name"
                  [href]="'/d/' + encode(loc.name)"
                  [active]="isActive(loc.name)"
                  [badge]="loc.access === 'read' ? 'view' : undefined"
                  (click)="go($event, '/d/' + encode(loc.name)); shell.closeSidebar()"
                >
                  <mk-icon mkNavIcon [name]="loc.error ? 'circle-alert' : loc.icon" />
                </mk-nav-item>
              }
            </mk-nav-group>
          }
          @if (drive.signedIn()) {
            <mk-nav-group label="Library">
              <mk-nav-item label="Home" href="/" [active]="url() === '/'" (click)="go($event, '/'); shell.closeSidebar()"
                ><mk-icon mkNavIcon name="home"
              /></mk-nav-item>
              <mk-nav-item label="Photos" href="/photos" [active]="url().startsWith('/photos')" (click)="go($event, '/photos'); shell.closeSidebar()"
                ><mk-icon mkNavIcon name="image"
              /></mk-nav-item>
              <mk-nav-item label="Recent" href="/recent" [active]="url().startsWith('/recent')" (click)="go($event, '/recent'); shell.closeSidebar()"
                ><mk-icon mkNavIcon name="clock"
              /></mk-nav-item>
              <mk-nav-item label="Starred" href="/starred" [active]="url().startsWith('/starred')" (click)="go($event, '/starred'); shell.closeSidebar()"
                ><mk-icon mkNavIcon name="star"
              /></mk-nav-item>
              <mk-nav-item
                label="Shared with me"
                href="/shared"
                [active]="url().startsWith('/shared')"
                [badge]="drive.shared().length || undefined"
                (click)="go($event, '/shared'); shell.closeSidebar()"
                ><mk-icon mkNavIcon name="users"
              /></mk-nav-item>
            </mk-nav-group>
            @if (drive.nas()) {
              <mk-nav-group label="Storage">
                @for (link of storageLinks; track link.path) {
                  <mk-nav-item
                    [label]="link.label"
                    [href]="link.path"
                    [active]="url().startsWith(link.path)"
                    (click)="go($event, link.path); shell.closeSidebar()"
                  >
                    <mk-icon mkNavIcon [name]="link.icon" />
                  </mk-nav-item>
                }
              </mk-nav-group>
            }
            <mk-nav-group label="Settings">
              @for (link of settingsLinks(); track link.path) {
                <mk-nav-item
                  [label]="link.label"
                  [href]="link.path"
                  [active]="url().startsWith(link.path)"
                  (click)="go($event, link.path); shell.closeSidebar()"
                >
                  <mk-icon mkNavIcon [name]="link.icon" />
                </mk-nav-item>
              }
            </mk-nav-group>
          }
          @if (!collapsed() && currentLocation(); as loc) {
            @if (loc.space; as sp) {
              <div class="space">
                <div class="space__bar"><span [style.width.%]="usedPercent(sp)"></span></div>
                <div class="space__text muted">{{ f.bytes(sp.total - sp.free, 0) }} of {{ f.bytes(sp.total, 0) }} used</div>
              </div>
            }
          }
          @if (!collapsed() && drive.meta(); as meta) {
            <div class="about muted" [title]="'build ' + meta.build">{{ meta.app }} {{ meta.version }}</div>
          }
        </mk-nav-list>

        <router-outlet />
      </mk-app-shell>
      @if (drive.signedIn()) {
        <mk-command-palette [commands]="commands()" placeholder="Go to, or do…" (commandSelected)="run($event)" />
      }
    }
    <app-upload-panel />
    <mk-toast-container />
  `,
  styles: [
    `
      .demo {
        background: var(--mk-warning-subtle);
        color: var(--mk-warning-subtle-text);
        font-size: var(--mk-font-size-sm);
        text-align: center;
        padding: 6px var(--mk-space-4);
      }
      .hdr {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        width: 100%;
        padding: 0 var(--mk-space-4);
      }
      .about {
        margin-top: auto;
        padding: var(--mk-space-3) var(--mk-space-4);
        font-size: var(--mk-font-size-xs);
      }
      .hdr__brand {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
        color: inherit;
        text-decoration: none;
        font-weight: 600;
      }
      .hdr__logo {
        display: block;
        width: 28px;
        height: 28px;
      }
      .hdr__spacer {
        flex: 1;
      }
      .who {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        padding: 4px 10px 4px 4px;
        border-radius: var(--mk-radius-pill);
        cursor: pointer;
      }
      .who:hover {
        background: var(--mk-hover-overlay);
      }
      .who:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
      }
      .who__name {
        font-weight: 500;
        font-size: var(--mk-font-size-sm);
      }
      .space {
        padding: var(--mk-space-4) var(--mk-space-4) 0;
        box-sizing: border-box;
        font-size: var(--mk-font-size-xs);
      }
      .space__bar {
        height: 6px;
        border-radius: 999px;
        background: var(--mk-border-subtle);
        overflow: hidden;
        margin-bottom: var(--mk-space-1);
      }
      .space__bar span {
        display: block;
        height: 100%;
        background: var(--mk-primary);
        border-radius: inherit;
      }
      @media (max-width: 640px) {
        .hdr {
          padding: 0 var(--mk-space-3);
          gap: var(--mk-space-1);
        }
        .who__name {
          display: none;
        }
      }
    `,
  ],
})
export class App {
  protected readonly drive = inject(DriveService);
  protected readonly theme = inject(MkThemeService);
  private readonly router = inject(Router);
  private readonly dialog = inject(MkDialogService);
  private readonly api = inject(ApiService);
  /** Instantiated for its effect: the accent chosen on the Account page comes back on every load. */
  private readonly accent = inject(MkAccentService);
  protected readonly collapsed = signal(false);
  protected readonly f = { bytes };

  protected readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** Sign-in and set-up stand alone, without the shell around them. */
  protected readonly bare = computed(() => /^\/(login|setup|s\/)/.test(this.url()));
  protected readonly settingsLinks = computed(() => SETTINGS.filter((l) => !l.admin || this.drive.isAdmin()));
  protected readonly storageLinks = STORAGE;

  /** Ctrl/⌘ K: jump anywhere, switch the theme, sign out. */
  protected readonly commands = computed<MkCommand[]>(() => [
    ...this.drive.locations().map<MkCommand>((l) => ({ id: `loc:${l.name}`, label: l.name, group: 'Locations', icon: l.icon, keywords: 'open go location' })),
    { id: 'home', label: 'Home', group: 'Library', icon: 'home', keywords: 'new arrivals start' },
    { id: 'photos', label: 'Photos', group: 'Library', icon: 'image' },
    { id: 'recent', label: 'Recent', group: 'Library', icon: 'clock' },
    { id: 'starred', label: 'Starred', group: 'Library', icon: 'star' },
    { id: 'shared', label: 'Shared with me', group: 'Library', icon: 'users' },
    ...(this.drive.nas() ? STORAGE.map<MkCommand>((l) => ({ id: `go:${l.path}`, label: l.label, group: 'Storage', icon: l.icon, keywords: 'nas zfs' })) : []),
    ...this.settingsLinks().map<MkCommand>((l) => ({ id: `go:${l.path}`, label: l.label, group: 'Settings', icon: l.icon })),
    {
      id: 'theme',
      label: this.theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme',
      group: 'Appearance',
      icon: this.theme.isDark() ? 'sun' : 'moon',
    },
    ...(this.drive.me()?.via === 'session' ? [{ id: 'signout', label: 'Sign out', group: 'Account', icon: 'log-out' } as MkCommand] : []),
  ]);

  run(cmd: MkCommand): void {
    if (cmd.id.startsWith('loc:')) this.nav('/d/' + encodeURIComponent(cmd.id.slice(4)));
    else if (cmd.id.startsWith('go:')) this.nav(cmd.id.slice(3));
    else if (cmd.id === 'home') this.nav('/');
    else if (cmd.id === 'photos') this.nav('/photos');
    else if (cmd.id === 'recent') this.nav('/recent');
    else if (cmd.id === 'starred') this.nav('/starred');
    else if (cmd.id === 'shared') this.nav('/shared');
    else if (cmd.id === 'theme') this.theme.toggle();
    else if (cmd.id === 'signout') void this.drive.signOut();
  }

  protected readonly currentLocation = computed(() => {
    const m = /^\/d\/([^/?#]+)/.exec(this.url());
    return m ? this.drive.location(decodeURIComponent(m[1])) : undefined;
  });

  private readonly toast = inject(MkToastService);
  private readonly updates = inject(SwUpdate);

  constructor() {
    void this.drive.ready();
    // installed as an app: offer the new build when one is ready instead of waiting for the next launch
    if (this.updates.isEnabled) {
      this.updates.versionUpdates.subscribe((ev) => {
        if (ev.type === 'VERSION_READY')
          this.toast.info('A new version of mk-drive is ready.', { duration: 0, action: { label: 'Reload', handler: () => location.reload() } });
      });
    }
  }

  encode(name: string): string {
    return encodeURIComponent(name);
  }

  isActive(name: string): boolean {
    return this.currentLocation()?.name === name;
  }

  usedPercent(sp: { free: number; total: number }): number {
    return sp.total ? Math.min(100, Math.round(((sp.total - sp.free) / sp.total) * 100)) : 0;
  }

  nav(path: string): void {
    void this.router.navigateByUrl(path);
  }

  /** The header's name for this drive; empty puts the app's own back. */
  async rename(): Promise<void> {
    const typed = await this.dialog.prompt({
      title: 'Rename this drive',
      message: 'The name in the header, for everyone who opens it. Leave it empty to go back to the default.',
      label: 'Name',
      placeholder: 'mk-drive',
      value: this.drive.meta()?.name ?? '',
      confirmText: 'Rename',
    });
    if (typed === null) return;
    try {
      const r = await this.api.renameDrive(typed);
      this.drive.setDriveName(r.name);
      this.toast.success(r.name ? `This drive is now “${r.name}”` : 'Back to the default name');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  go(ev: Event, path: string): void {
    ev.preventDefault();
    this.nav(path);
  }
}
