import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkToastService } from '@mk-kit/ui/feedback';
import { MkInput } from '@mk-kit/ui/forms';
import { NgTemplateOutlet } from '@angular/common';
import { MkTab, MkTabs } from '@mk-kit/ui/navigation';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { SettingsShell } from './shell';

type Os = 'linux' | 'mac' | 'windows' | 'ios' | 'android' | 'other';

function detectOs(): Os {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Mac OS/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

/** Copy-paste steps to reach the drive from a computer or a phone, with a fresh app password filled in. */
@Component({
  selector: 'app-connect',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, SettingsShell, MkButton, MkIcon, MkInput, MkTabs, MkTab],
  template: `
    <app-settings heading="Connect this computer" description="The drive speaks WebDAV, so file managers mount it without any add-on. Programs sign in with an app password, never with your account password.">
      <section class="secret">
        @if (secret(); as s) {
          <div class="secret__made"><mk-icon name="key" size="sm" /> App password “{{ madeName() }}” filled into the steps below. It is shown only now — it stays valid until you remove it under Devices.</div>
          <div class="row">
            <input mkInput readonly [value]="s" (focus)="$any($event.target).select()" aria-label="App password" class="mono" />
            <button mkButton (click)="copy(s, 'App password')"><mk-icon name="copy" size="sm" /> Copy</button>
          </div>
        } @else {
          <form class="row" (submit)="make($event)">
            <input mkInput [value]="name()" (input)="name.set($any($event.target).value)" placeholder="Name this computer, e.g. “ThinkPad”" aria-label="Name" maxlength="60" />
            <button mkButton type="submit" [loading]="making()" [disabled]="!name().trim()"><mk-icon name="key" size="sm" /> Make an app password</button>
          </form>
          <p class="muted small">Without one, the steps show <code>&lt;app password&gt;</code> where yours goes.</p>
        }
      </section>

      <mk-tabs>
        @for (os of order(); track os) {
          <mk-tab [label]="labels[os]">
            @switch (os) {
              @case ('linux') {
                <h3>GNOME Files</h3>
                <ol>
                  <li>Open Files → <em>Other Locations</em>.</li>
                  <li>In <em>Connect to Server</em> paste the address and press Connect:</li>
                </ol>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: davsUrl(), label: 'Address' }" />
                <ol start="3">
                  <li>Password: the app password. Tick <em>Remember forever</em>.</li>
                </ol>
                <h3>KDE Dolphin</h3>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: 'webdavs://' + emailEnc() + '@' + host() + '/dav/', label: 'Address' }" />
                <h3>From a terminal (GVFS)</h3>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: 'gio mount ' + davsUrl(), label: 'Command' }" />
                <ng-container *ngTemplateOutlet="rclone" />
              }
              @case ('mac') {
                <h3>Finder</h3>
                <ol>
                  <li>Finder → <em>Go → Connect to Server</em> (⌘K).</li>
                  <li>Paste the address, press Connect, choose <em>Registered User</em>:</li>
                </ol>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: httpsUrl(), label: 'Address' }" />
                <ol start="3">
                  <li>Name: <code>{{ email() }}</code>, Password: the app password. Tick <em>Remember this password in my keychain</em>.</li>
                </ol>
                <ng-container *ngTemplateOutlet="rclone" />
              }
              @case ('windows') {
                <h3>Explorer</h3>
                <ol>
                  <li>Explorer → <em>This PC → Map network drive</em>.</li>
                  <li>Folder: paste the address; tick <em>Connect using different credentials</em>:</li>
                </ol>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: httpsUrl(), label: 'Folder' }" />
                <ol start="3">
                  <li>User: <code>{{ email() }}</code>, Password: the app password.</li>
                </ol>
                <p class="muted small">Windows only mounts WebDAV over HTTPS and sometimes needs the WebClient service started.</p>
                <ng-container *ngTemplateOutlet="rclone" />
              }
              @case ('ios') {
                <h3>iPhone and iPad</h3>
                <p>The Files app only connects to SMB by itself. Install a WebDAV client that plugs into Files — <strong>Documents by Readdle</strong>, FE File Explorer or Owlfiles — and add a WebDAV connection:</p>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: httpsUrl(), label: 'Address' }" />
                <p>User: <code>{{ email() }}</code>, password: the app password. The drive then appears in Files under <em>Browse → Locations</em> and in every app's file picker.</p>
              }
              @case ('android') {
                <h3>Android</h3>
                <p>Any WebDAV-capable file manager works (Solid Explorer, Cx File Explorer, Material Files). Add a WebDAV storage:</p>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: httpsUrl(), label: 'Address' }" />
                <p>User: <code>{{ email() }}</code>, password: the app password.</p>
              }
              @default {
                <h3>Any WebDAV client</h3>
                <ng-container *ngTemplateOutlet="snippet; context: { $implicit: httpsUrl(), label: 'Address' }" />
                <p>User: <code>{{ email() }}</code>, password: the app password.</p>
                <ng-container *ngTemplateOutlet="rclone" />
              }
            }
          </mk-tab>
        }
        <mk-tab label="Scripts">
          <h3>curl</h3>
          <ng-container *ngTemplateOutlet="snippet; context: { $implicit: curlCmd(), label: 'List a location' }" />
          <ng-container *ngTemplateOutlet="snippet; context: { $implicit: curlUpload(), label: 'Upload a file' }" />
          <h3>The JSON API</h3>
          <p>Every <code>/api/…</code> call takes <code>Authorization: Basic email:secret</code> or <code>Bearer secret</code>.</p>
          <ng-container *ngTemplateOutlet="snippet; context: { $implicit: curlApi(), label: 'List a folder as JSON' }" />
        </mk-tab>
      </mk-tabs>

      <ng-template #rclone>
        <h3>rclone: files on demand, on any system</h3>
        <p>The closest thing to a sync client: a mounted folder that downloads what you open and keeps a local cache. One-time setup, then a mount command.</p>
        <ng-container *ngTemplateOutlet="snippet; context: { $implicit: rcloneConfig(), label: 'Once' }" />
        <ng-container *ngTemplateOutlet="snippet; context: { $implicit: rcloneMount(), label: 'Mount (Linux / macOS; on Windows use a drive letter instead of a folder)' }" />
      </ng-template>

      <ng-template #snippet let-text let-label="label">
        <div class="snippet">
          <div class="snippet__label muted small">{{ label }}</div>
          <div class="row">
            <pre class="snippet__code">{{ text }}</pre>
            <button mkButton variant="ghost" size="sm" iconOnly [attr.aria-label]="'Copy ' + label" (click)="copy(text, label)"><mk-icon name="copy" size="sm" /></button>
          </div>
        </div>
      </ng-template>
    </app-settings>
  `,
  styles: [
    `
      .secret {
        margin-bottom: var(--mk-space-5);
      }
      .secret__made {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        margin-bottom: var(--mk-space-3);
        font-weight: 500;
      }
      .row {
        display: flex;
        gap: var(--mk-space-2);
        align-items: flex-start;
      }
      .row input {
        flex: 1;
        min-width: 0;
      }
      h3 {
        font-size: var(--mk-font-size-md);
        font-weight: 600;
        margin: var(--mk-space-5) 0 var(--mk-space-2);
      }
      ol,
      p {
        margin: 0 0 var(--mk-space-2);
      }
      ol {
        padding-left: var(--mk-space-5);
      }
      .snippet {
        margin: var(--mk-space-2) 0 var(--mk-space-3);
      }
      .snippet__label {
        margin-bottom: var(--mk-space-1);
      }
      .snippet__code {
        flex: 1;
        min-width: 0;
        margin: 0;
        padding: var(--mk-space-2) var(--mk-space-3);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface-sunken, var(--mk-surface));
        font-family: var(--mk-font-mono);
        font-size: var(--mk-font-size-xs);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class ConnectPage {
  protected readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  protected readonly labels: Record<Os, string> = { linux: 'Linux', mac: 'macOS', windows: 'Windows', ios: 'iPhone / iPad', android: 'Android', other: 'Other' };
  protected readonly order = computed<Os[]>(() => {
    const mine = detectOs();
    const all: Os[] = ['linux', 'mac', 'windows', 'ios', 'android'];
    return mine === 'other' ? [...all, 'other'] : [mine, ...all.filter((o) => o !== mine)];
  });
  protected readonly name = signal('');
  protected readonly making = signal(false);
  protected readonly secret = signal<string | null>(null);
  protected readonly madeName = signal('');
  protected readonly host = computed(() => location.host);
  protected readonly email = computed(() => this.drive.me()?.email ?? 'you@example.com');
  protected readonly emailEnc = computed(() => encodeURIComponent(this.email()));
  protected readonly pw = computed(() => this.secret() ?? '<app password>');
  protected readonly httpsUrl = computed(() => `${location.origin}/dav/`);
  protected readonly davsUrl = computed(() => `davs://${this.emailEnc()}@${this.host()}/dav/`);
  protected readonly firstLocation = computed(() => this.drive.locations()[0]?.name ?? 'Drive');
  protected readonly curlCmd = computed(() => `curl -u '${this.email()}:${this.pw()}' -X PROPFIND -H 'Depth: 1' ${this.httpsUrl()}${encodeURIComponent(this.firstLocation())}/`);
  protected readonly curlUpload = computed(() => `curl -u '${this.email()}:${this.pw()}' -T ./photo.jpg ${this.httpsUrl()}${encodeURIComponent(this.firstLocation())}/photo.jpg`);
  protected readonly curlApi = computed(() => `curl -u '${this.email()}:${this.pw()}' '${location.origin}/api/ls?path=${encodeURIComponent(this.firstLocation())}'`);
  protected readonly rcloneConfig = computed(() => `rclone config create mk-drive webdav url=${this.httpsUrl()} vendor=other user='${this.email()}' pass='${this.pw()}' --obscure`);
  protected readonly rcloneMount = computed(() => `mkdir -p ~/mk-drive && rclone mount mk-drive: ~/mk-drive --vfs-cache-mode full --daemon`);

  async make(ev: Event): Promise<void> {
    ev.preventDefault();
    this.making.set(true);
    try {
      const t = await this.api.createAppPassword(this.name().trim());
      this.secret.set(t.secret);
      this.madeName.set(t.name);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.making.set(false);
    }
  }

  async copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success(`${what} copied`);
    } catch {
      this.toast.warning('Could not copy — select it and copy by hand');
    }
  }
}
