import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkButton } from '@mk-kit/ui/button';
import { MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkFormField, MkPasswordInput } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import type { Tunnel } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { DriveService } from '../../core/drive.service';
import { ago } from '../../core/format';
import { ms } from './load';

type TunnelView = Tunnel & { viaTunnel: boolean };

/**
 * Reach the drive from outside: a Cloudflare Tunnel run next to the drive on the box. The person pastes the token from
 * Cloudflare's dashboard; the box starts the tunnel and this card follows it. Hostnames stay in Cloudflare's dashboard.
 * Changing the tunnel through the tunnel itself is refused (it would cut the connection in use).
 */
@Component({
  selector: 'app-tunnel-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkTag, MkAlert, MkFormField, MkPasswordInput, MkIcon, RouterLink],
  template: `
    <section class="card">
      <div class="head">
        <h2>Reach the drive from outside</h2>
        @if (t(); as t) {
          <mk-tag size="sm" [tone]="tone(t)">{{ label(t) }}</mk-tag>
        }
        <span class="spacer"></span>
        <button mkButton variant="ghost" size="sm" iconOnly aria-label="Refresh the tunnel status" [loading]="loading()" (click)="load()">
          <mk-icon name="refresh-cw" size="sm" />
        </button>
      </div>
      <p class="muted small">
        A Cloudflare Tunnel brings the drive to an address like https://drive.example.com without opening a port on the router. Only the drive goes through it:
        SMB, NFS and ssh stay on the local network.
      </p>

      @if (error()) {
        <mk-alert tone="danger" title="Could not read the tunnel" class="alert">{{ error() }}</mk-alert>
      }
      @if (t(); as t) {
        @if (t.configured) {
          <dl class="facts">
            @if (t.hostnames.length) {
              <dt>Public address</dt>
              <dd>
                @for (h of t.hostnames; track h) {
                  <a [href]="'https://' + h" target="_blank" rel="noopener">https://{{ h }}</a>
                }
              </dd>
            }
            @if (t.connections !== null) {
              <dt>Connections</dt>
              <dd>{{ t.connections }} to Cloudflare{{ t.lastConnectedAt ? ', last made ' + ago(ms(t.lastConnectedAt)) : '' }}</dd>
            }
            @if (t.tunnelId) {
              <dt>Tunnel</dt>
              <dd class="mono">{{ t.tunnelId }}</dd>
            }
            @if (t.since) {
              <dt>Running since</dt>
              <dd>{{ ago(ms(t.since)) }}{{ t.restarts ? ' · restarted ' + t.restarts + '×' : '' }}</dd>
            }
          </dl>
          @if (!t.hostnames.length && t.state === 'connected') {
            <p class="muted small">
              Connected, but Cloudflare has not given it a public hostname yet: in the dashboard, add one to this tunnel with service HTTP → localhost:8810.
            </p>
          }
          @if (t.lastError && t.state !== 'connected') {
            <mk-alert tone="warning" title="The tunnel cannot connect" class="alert">
              {{ t.lastError }}
              @if (t.lastError.includes('Failed to get tunnel')) {
                <br />Usually a token copied incompletely, or a tunnel deleted in the dashboard.
              }
            </mk-alert>
          }
        }

        @if (t.configured && passwordEverywhereWithSso()) {
          <p class="muted small">
            The password form is offered through this tunnel too, and wrong passwords for an address pause its sign-in, so someone who knows the address can
            keep it paused from outside. Single sign-on is on: <a routerLink="/settings/sign-in">Settings → Sign-in</a> can limit passwords to the local
            network.
          </p>
        }

        @if (t.viaTunnel) {
          <mk-alert tone="info" title="You are connected through this tunnel" class="alert">
            Changing or removing it from here would cut this connection, so that is possible only from home, on the local network.
          </mk-alert>
        } @else {
          <form class="form" (submit)="save($event)">
            <mk-form-field [label]="t.configured ? 'Replace the tunnel token' : 'Tunnel token'">
              <mk-password-input [(value)]="token" autocomplete="off" />
            </mk-form-field>
            <p class="muted small">
              Cloudflare Zero Trust → Networks → Tunnels → create a tunnel (Cloudflared, Docker): the long string after <code>--token</code>. Then give the
              tunnel a public hostname with service HTTP → <code>localhost:8810</code>.
            </p>
            <div class="actions">
              <button mkButton type="submit" [loading]="saving()" [disabled]="token().trim().length < 40">{{ t.configured ? 'Replace' : 'Connect' }}</button>
              @if (t.configured) {
                <button mkButton variant="ghost" tone="danger" type="button" [loading]="removing()" (click)="turnOff()">Turn off</button>
              }
            </div>
          </form>
        }
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
      .spacer {
        flex: 1;
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
        display: flex;
        flex-wrap: wrap;
        gap: var(--mk-space-1) var(--mk-space-3);
        overflow-wrap: anywhere;
      }
      code {
        font-family: var(--mk-font-mono);
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
export class TunnelCard {
  private readonly api = inject(ApiService);
  private readonly drive = inject(DriveService);
  /** Passwords everywhere while single sign-on is on: the one case where limiting them to the local network costs nothing and closes the door from outside. */
  protected readonly passwordEverywhereWithSso = computed(() => {
    const m = this.drive.meta();
    return !!m?.sso && !!m.passwordLogin && !m.passwordLoginLocal;
  });
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly ago = ago;
  protected readonly ms = ms;
  protected readonly t = signal<TunnelView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly removing = signal(false);
  protected readonly token = signal('');

  constructor() {
    void this.load();
    // a tunnel settles within seconds of starting; keep the card current while the page is open
    const timer = setInterval(() => {
      const s = this.t()?.state;
      if (s && s !== 'off') void this.load(true);
    }, 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  tone(t: TunnelView): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
    return t.state === 'connected' ? 'success' : t.state === 'off' ? 'neutral' : t.state === 'starting' ? 'info' : t.state === 'failing' ? 'danger' : 'warning';
  }

  label(t: TunnelView): string {
    return { off: 'off', starting: 'starting', connected: 'connected', disconnected: 'not connected', failing: 'not running' }[t.state];
  }

  async load(quiet = false): Promise<void> {
    if (!quiet) this.loading.set(true);
    try {
      this.t.set(await this.api.nas.tunnel());
      this.error.set(null);
    } catch (e) {
      if (!quiet) this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  async save(ev: Event): Promise<void> {
    ev.preventDefault();
    this.saving.set(true);
    try {
      this.t.set(await this.api.nas.setTunnel(this.token().trim()));
      this.token.set('');
      this.toast.success('The tunnel is starting');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  async turnOff(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Turn off the tunnel?',
      message:
        'The drive stops answering at its public address; at home nothing changes. The token is removed from the box; the tunnel stays in your Cloudflare dashboard.',
      confirmText: 'Turn off',
      tone: 'danger',
    });
    if (!ok) return;
    this.removing.set(true);
    try {
      this.t.set(await this.api.nas.removeTunnel());
      this.toast.success('The tunnel is off');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.removing.set(false);
    }
  }
}
