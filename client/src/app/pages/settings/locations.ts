import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTag } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkSelect, type MkSelectOption } from '@mk-kit/ui/forms';
import { MkEmptyState } from '@mk-kit/ui/status';
import type { Connector, ConnectorType, LocationMode } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { bytes } from '../../core/format';
import { SettingsShell } from './shell';

const TYPES: MkSelectOption[] = [
  { label: 'WebDAV (Nextcloud, another mk-drive, …)', value: 'webdav' },
  { label: 'S3 bucket (AWS, MinIO, Backblaze, R2, …)', value: 's3' },
];
const MODES: MkSelectOption[] = [
  { label: 'Read and write', value: 'rw' },
  { label: 'Read-only', value: 'ro' },
];

/** Every location the drive serves: the host mounts (from the environment) and the connectors admins add here. */
@Component({
  selector: 'app-locations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsShell, MkButton, MkIcon, MkTag, MkEmptyState, MkFormField, MkInput, MkSelect],
  template: `
    <app-settings
      heading="Locations"
      description="Directories mounted into the container come from the environment; a WebDAV server or an S3 bucket can be added here."
    >
      <h2>Mounted</h2>
      @if (mounts().length === 0) {
        <p class="muted">No directories are mounted. Mount some under <code>/locations</code> or set <code>DRIVE_LOCATIONS</code>.</p>
      } @else {
        <ul class="list">
          @for (l of mounts(); track l.name) {
            <li class="item">
              <mk-icon [name]="l.icon" class="item__icon" />
              <div class="item__main">
                <div class="item__title">
                  {{ l.name }}
                  @if (l.mode === 'ro') {
                    <mk-tag size="sm" tone="neutral">read-only</mk-tag>
                  }
                  @if (l.error) {
                    <mk-tag size="sm" tone="danger">{{ l.error }}</mk-tag>
                  }
                </div>
                <div class="muted item__meta">
                  {{ l.space ? f.bytes(l.space.total - l.space.free) + ' of ' + f.bytes(l.space.total) + ' used' : 'host directory' }}
                </div>
              </div>
            </li>
          }
        </ul>
      }

      <h2>Connectors</h2>
      @if (connectors(); as list) {
        @if (list.length === 0 && !adding()) {
          <mk-empty-state
            icon="cloud"
            title="No connectors yet"
            description="Add a WebDAV server or an S3 bucket and it becomes a location like the others: grants, sharing, trash."
          />
        }
        <ul class="list">
          @for (c of list; track c.name) {
            <li class="item">
              <mk-icon [name]="c.icon" class="item__icon" />
              <div class="item__main">
                <div class="item__title">
                  {{ c.name }} <mk-tag size="sm">{{ c.type === 's3' ? 'S3' : 'WebDAV' }}</mk-tag>
                  @if (c.mode === 'ro') {
                    <mk-tag size="sm" tone="neutral">read-only</mk-tag>
                  }
                </div>
                <div class="muted item__meta mono">
                  {{
                    c.type === 's3' ? c.config['endpoint'] + ' · ' + c.config['bucket'] + (c.config['prefix'] ? '/' + c.config['prefix'] : '') : c.config['url']
                  }}
                </div>
              </div>
              <button mkButton variant="ghost" size="sm" tone="danger" (click)="remove(c)">Remove</button>
            </li>
          }
        </ul>
      }

      @if (adding()) {
        <form class="form" (submit)="save($event)">
          <div class="row">
            <mk-form-field label="Name"
              ><input mkInput [value]="name()" (input)="name.set($any($event.target).value)" placeholder="Cloud" maxlength="60" required
            /></mk-form-field>
            <mk-form-field label="Type"><mk-select [options]="types" [(value)]="type" /></mk-form-field>
            <mk-form-field label="Access"><mk-select [options]="modes" [(value)]="mode" /></mk-form-field>
          </div>
          @if (type() === 'webdav') {
            <mk-form-field
              label="WebDAV URL"
              hint="The collection that becomes the root, e.g. https://cloud.example.com/remote.php/dav/files/anna/ or https://other-drive/dav/Docs/"
              ><input mkInput [value]="url()" (input)="url.set($any($event.target).value)" placeholder="https://…/" required
            /></mk-form-field>
            <div class="row">
              <mk-form-field label="Username"
                ><input mkInput [value]="username()" (input)="username.set($any($event.target).value)" autocomplete="off"
              /></mk-form-field>
              <mk-form-field label="Password or app password"
                ><input mkInput type="password" [value]="secret()" (input)="secret.set($any($event.target).value)" autocomplete="new-password"
              /></mk-form-field>
            </div>
          } @else {
            <div class="row">
              <mk-form-field label="Endpoint" hint="https://s3.eu-central-1.amazonaws.com, https://minio.lan:9000, https://<account>.r2.cloudflarestorage.com"
                ><input mkInput [value]="endpoint()" (input)="endpoint.set($any($event.target).value)" placeholder="https://…" required
              /></mk-form-field>
              <mk-form-field label="Region"
                ><input mkInput [value]="region()" (input)="region.set($any($event.target).value)" placeholder="us-east-1"
              /></mk-form-field>
            </div>
            <div class="row">
              <mk-form-field label="Bucket"><input mkInput [value]="bucket()" (input)="bucket.set($any($event.target).value)" required /></mk-form-field>
              <mk-form-field label="Prefix (optional)" hint="A folder inside the bucket to use as the root"
                ><input mkInput [value]="prefix()" (input)="prefix.set($any($event.target).value)" placeholder="photos/2026"
              /></mk-form-field>
            </div>
            <div class="row">
              <mk-form-field label="Access key"
                ><input mkInput [value]="accessKey()" (input)="accessKey.set($any($event.target).value)" autocomplete="off" required
              /></mk-form-field>
              <mk-form-field label="Secret key"
                ><input mkInput type="password" [value]="secret()" (input)="secret.set($any($event.target).value)" autocomplete="new-password" required
              /></mk-form-field>
            </div>
          }
          <div class="actions">
            <button mkButton type="submit" [loading]="saving()" [disabled]="!valid()"><mk-icon name="plug" size="sm" /> Connect and add</button>
            <button mkButton variant="ghost" type="button" (click)="adding.set(false)">Cancel</button>
            <span class="muted small">The connection is tried first; nothing is saved if it fails.</span>
          </div>
        </form>
      } @else {
        <div class="toolbar">
          <button mkButton (click)="adding.set(true)"><mk-icon name="plus" /> Add a connector</button>
        </div>
      }
      <p class="muted small">SMB shares are mounted on the host and appear under Mounted; Node has no SMB client worth shipping.</p>
    </app-settings>
  `,
  styles: [
    `
      h2 {
        font-size: var(--mk-font-size-lg);
        margin: var(--mk-space-6) 0 var(--mk-space-2);
      }
      h2:first-of-type {
        margin-top: 0;
      }
      .list {
        list-style: none;
        padding: 0;
        margin: 0 0 var(--mk-space-4);
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
      .form {
        display: grid;
        gap: var(--mk-space-3);
        padding: var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        margin-bottom: var(--mk-space-4);
      }
      .row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--mk-space-3);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .toolbar {
        margin-bottom: var(--mk-space-4);
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class LocationsPage {
  protected readonly drive = inject(DriveService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly f = { bytes };
  protected readonly types = TYPES;
  protected readonly modes = MODES;
  protected readonly mounts = computed(() => this.drive.locations().filter((l) => l.source === 'mount'));
  protected readonly connectors = signal<Connector[] | null>(null);
  protected readonly adding = signal(false);
  protected readonly saving = signal(false);
  protected readonly name = signal('');
  protected readonly type = signal<ConnectorType>('webdav');
  protected readonly mode = signal<LocationMode>('rw');
  protected readonly url = signal('');
  protected readonly username = signal('');
  protected readonly secret = signal('');
  protected readonly endpoint = signal('');
  protected readonly region = signal('');
  protected readonly bucket = signal('');
  protected readonly prefix = signal('');
  protected readonly accessKey = signal('');
  protected readonly valid = computed(
    () =>
      !!this.name().trim() &&
      (this.type() === 'webdav' ? !!this.url().trim() : !!(this.endpoint().trim() && this.bucket().trim() && this.accessKey().trim() && this.secret())),
  );

  constructor() {
    void this.drive.ready().then(() => this.load());
  }

  private async load(): Promise<void> {
    try {
      this.connectors.set(await this.api.connectors());
    } catch (e) {
      this.toast.danger(errorMessage(e));
      this.connectors.set([]);
    }
  }

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    this.saving.set(true);
    try {
      const config =
        this.type() === 'webdav'
          ? { url: this.url().trim(), username: this.username().trim() || undefined, password: this.secret() || undefined }
          : {
              endpoint: this.endpoint().trim(),
              region: this.region().trim() || undefined,
              bucket: this.bucket().trim(),
              prefix: this.prefix().trim() || undefined,
              accessKey: this.accessKey().trim(),
              secretKey: this.secret(),
            };
      const c = await this.api.addConnector({ name: this.name().trim(), type: this.type(), mode: this.mode(), config });
      this.connectors.update((l) => [...(l ?? []), c]);
      this.adding.set(false);
      for (const s of [this.name, this.url, this.username, this.secret, this.endpoint, this.region, this.bucket, this.prefix, this.accessKey]) s.set('');
      await this.drive.refreshLocations();
      this.toast.success(`“${c.name}” connected`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  async remove(c: Connector): Promise<void> {
    if (
      !(await this.dialog.confirm({
        title: `Remove “${c.name}”?`,
        message: 'The location disappears from the drive and its grants are dropped. Nothing is deleted on the other side.',
        confirmText: 'Remove',
        tone: 'danger',
      }))
    )
      return;
    try {
      await this.api.removeConnector(c.name);
      this.connectors.update((l) => l?.filter((x) => x.name !== c.name) ?? null);
      await this.drive.refreshLocations();
      this.toast.success(`“${c.name}” removed`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
