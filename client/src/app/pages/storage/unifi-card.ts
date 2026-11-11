import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkFormField, MkInput, MkPasswordInput } from '@mk-kit/ui/forms';
import type { Unifi } from '../../../../../shared/types';
import { ApiService, errorMessage } from '../../core/api.service';
import { ago } from '../../core/format';
import { ms } from './load';

/**
 * Names instead of addresses: a UniFi console the drive asks what each address on the network is called, so the
 * Shares page can say who is connected by name. The drive only reads the client list; the key stays on the server.
 */
@Component({
  selector: 'app-unifi-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkTag, MkAlert, MkFormField, MkInput, MkPasswordInput],
  template: `
    <section class="card">
      <div class="head">
        <h2>Names from UniFi</h2>
        @if (u(); as u) {
          @if (u.url) {
            <mk-tag size="sm" [tone]="u.lastOk === false ? 'danger' : 'success'">{{ u.lastOk === false ? 'not answering' : 'connected' }}</mk-tag>
          }
        }
      </div>
      <p class="muted small">
        The box knows who is connected only by address. A UniFi console knows what each address is called, and with a key to read its client list the Shares
        page shows those names. Nothing is changed on the console.
      </p>

      @if (error()) {
        <mk-alert tone="danger" title="Could not read the UniFi settings" class="alert">{{ error() }}</mk-alert>
      }
      @if (u(); as u) {
        @if (u.url) {
          <dl class="facts">
            <dt>Console</dt>
            <dd class="mono">{{ u.url }}</dd>
            @if (u.sites.length) {
              <dt>{{ u.sites.length === 1 ? 'Site' : 'Sites' }}</dt>
              <dd>{{ u.sites.join(', ') }}</dd>
            }
            @if (u.clients !== null) {
              <dt>Clients with a name</dt>
              <dd>{{ u.clients }}{{ u.lastAt ? ', read ' + ago(ms(u.lastAt)) : '' }}</dd>
            }
            @if (u.fingerprint) {
              <dt>Certificate</dt>
              <dd class="mono print" title="SHA-256 of the certificate the console showed when this was saved">{{ u.fingerprint }}</dd>
            }
          </dl>
          @if (u.lastOk === false) {
            <mk-alert tone="warning" title="The console is not answering" class="alert">
              {{ u.lastError }}. Addresses are shown without names until it does.
            </mk-alert>
          }
        }
        <form class="form" (submit)="save($event)">
          <mk-form-field label="Console address" hint="The UniFi console on your network, like 192.168.1.1 or unifi.example.com.">
            <input mkInput [value]="url()" (input)="url.set($any($event.target).value)" autocomplete="off" placeholder="https://…" />
          </mk-form-field>
          <mk-form-field [label]="u.hasKey ? 'Replace the API key' : 'API key'">
            <mk-password-input [(value)]="key" autocomplete="off" />
          </mk-form-field>
          <p class="muted small">
            In UniFi Network: Settings → Control Plane → Integrations → create an API key. A console signs its own certificate, so the one it shows when you
            save is remembered and the key is sent to nothing else; save again after replacing or resetting the console.
          </p>
          <div class="actions">
            <button mkButton type="submit" [loading]="saving()" [disabled]="!canSave(u)">{{ u.url ? 'Save' : 'Connect' }}</button>
            @if (u.url) {
              <button mkButton variant="ghost" tone="danger" type="button" [loading]="removing()" (click)="turnOff()">Turn off</button>
            }
          </div>
        </form>
      } @else if (!error()) {
        <p class="muted small">Loading…</p>
      }
    </section>
  `,
  styles: [
    `
      .card {
        display: grid;
        gap: var(--mk-space-3);
        padding: var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        margin-bottom: var(--mk-space-4);
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
      }
      h2 {
        margin: 0;
        font-size: var(--mk-font-size-lg);
      }
      .small {
        font-size: var(--mk-font-size-sm);
        margin: 0;
      }
      .alert {
        display: block;
      }
      .facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--mk-space-1) var(--mk-space-4);
        margin: 0;
        font-size: var(--mk-font-size-sm);
      }
      .facts dt {
        color: var(--mk-text-muted);
      }
      .facts dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .mono {
        font-family: var(--mk-font-mono);
      }
      .print {
        font-size: var(--mk-font-size-xs);
      }
      .form {
        display: grid;
        gap: var(--mk-space-3);
        max-width: 36rem;
      }
      .actions {
        display: flex;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
    `,
  ],
})
export class UnifiCard {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly ago = ago;
  protected readonly ms = ms;
  protected readonly u = signal<Unifi | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly removing = signal(false);
  protected readonly url = signal('');
  protected readonly key = signal('');

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.show(await this.api.unifi.get());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  private show(u: Unifi): void {
    this.u.set(u);
    this.url.set(u.url ?? '');
    this.key.set('');
    this.error.set(null);
  }

  /** A new address needs its key; the saved key is kept only for the address it was saved with. */
  protected canSave(u: Unifi): boolean {
    const url = this.url().trim();
    if (!url) return false;
    return this.key().trim().length >= 16 || (u.hasKey && url === u.url);
  }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    const u = this.u();
    if (!u || !this.canSave(u)) return;
    this.saving.set(true);
    try {
      const key = this.key().trim();
      const next = await this.api.unifi.set({ url: this.url().trim(), ...(key ? { key } : {}) });
      this.show(next);
      this.toast.success(`The console answered: ${next.clients ?? 0} clients with a name`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  async turnOff(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Stop reading names from UniFi?',
      message: 'The address and the key are forgotten. The Shares page goes back to showing addresses.',
      confirmText: 'Turn off',
      tone: 'danger',
    });
    if (!ok) return;
    this.removing.set(true);
    try {
      this.show(await this.api.unifi.remove());
      this.toast.success('Turned off');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.removing.set(false);
    }
  }
}
