import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkTag } from '@mk-kit/ui/data';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import { MkCheckbox } from '@mk-kit/ui/checkbox';
import { MkFormField, MkInput } from '@mk-kit/ui/forms';
import { MkIcon } from '@mk-kit/ui/icon';
import type { NetInterface, Network } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';
import { StorageShell } from './shell';
import { loader, ms } from './load';
import { TunnelCard } from './tunnel-card';

const REVERT_AFTER = 120;

/**
 * The box's name and address. The name changes at once. An address change
 * is applied with a revert: the page tells the person where to open the
 * drive next and counts down; Keep from the new address makes it stay,
 * silence puts the old address back.
 */
@Component({
  selector: 'app-storage-network',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StorageShell, MkButton, MkTag, MkAlert, MkCheckbox, MkFormField, MkInput, MkIcon, TunnelCard],
  template: `
    <app-storage
      heading="Network"
      description="The box's name and address. A name change is instant; an address change reverts by itself unless you confirm it from the new address."
      [loading]="q.loading()"
      [loaded]="q.data() !== null"
      [error]="q.error()"
      (refresh)="q.run()"
    >
      @if (q.data(); as n) {
        @if (n.pending; as p) {
          <mk-alert tone="warning" title="A change to {{ p.interface }} is waiting to be kept" class="alert">
            <p class="note">
              Open the drive at its new address and press Keep before it reverts
              @if (secondsLeft(); as s) {
                — {{ s }} s left.
              } @else {
                .
              }
              @if (newUrl(); as url) {
                <br /><a [href]="url">{{ url }}</a>
              }
              @if (n.mdns) {
                <br />Or by name: <a [href]="localUrl(n)">{{ localUrl(n) }}</a>
              }
            </p>
            <button mkButton size="sm" [loading]="busy()" (click)="keep()"><mk-icon name="circle-check" size="sm" /> Keep this address</button>
          </mk-alert>
        }

        <section class="card">
          <h2>Name</h2>
          <form class="row" (submit)="setHostname($event)">
            <mk-form-field label="Hostname" [hint]="n.mdns ? n.hostname + '.local answers on this network (mDNS)' : 'Letters, digits and dashes'">
              <input mkInput [value]="hostname()" (input)="hostname.set($any($event.target).value)" autocomplete="off" required />
            </mk-form-field>
            <div class="actions">
              <button mkButton type="submit" [loading]="busy()" [disabled]="!hostnameValid() || hostname() === n.hostname">Rename</button>
            </div>
          </form>
          <p class="muted small">Gateway {{ n.gateway ?? '—' }} · DNS {{ n.dns.join(', ') || '—' }}</p>
        </section>

        @for (i of n.interfaces; track i.name) {
          <section class="card">
            <div class="head">
              <h2 class="mono">{{ i.name }}</h2>
              <mk-tag size="sm" [tone]="i.up ? 'success' : 'neutral'">{{ i.up ? 'up' : 'down' }}</mk-tag>
              @if (i.speed) {
                <span class="muted small">{{ i.speed >= 1000 ? i.speed / 1000 + ' Gbit/s' : i.speed + ' Mbit/s' }}</span>
              }
              @if (i.mac) {
                <span class="muted small mono">{{ i.mac }}</span>
              }
              <span class="spacer"></span>
              <span class="muted small">{{ i.addresses.join(', ') || 'no address' }} · {{ via(i) }}</span>
            </div>
            @if (editing() === i.name) {
              <form class="form" (submit)="apply($event, i)">
                <mk-checkbox [checked]="dhcp()" (checkedChange)="dhcp.set($event)">Get the address from the router (DHCP)</mk-checkbox>
                @if (!dhcp()) {
                  <div class="row">
                    <mk-form-field label="Address" hint="With the prefix, like 192.168.1.10/24">
                      <input mkInput [value]="address()" (input)="address.set($any($event.target).value)" placeholder="192.168.1.10/24" autocomplete="off" />
                    </mk-form-field>
                    <mk-form-field label="Gateway">
                      <input mkInput [value]="gateway()" (input)="gateway.set($any($event.target).value)" placeholder="192.168.1.1" autocomplete="off" />
                    </mk-form-field>
                    <mk-form-field label="DNS" hint="Up to three, comma-separated">
                      <input mkInput [value]="dns()" (input)="dns.set($any($event.target).value)" placeholder="192.168.1.1, 1.1.1.1" autocomplete="off" />
                    </mk-form-field>
                  </div>
                }
                <p class="muted small">
                  The change is applied now and reverts after {{ revertAfter }} s unless you press Keep from the new address. The drive, its shares and any copy
                  in flight are unreachable at the old address from that moment.
                </p>
                <div class="actions">
                  <button mkButton type="submit" tone="danger" [loading]="busy()" [disabled]="!formValid()">Apply to {{ i.name }}</button>
                  <button mkButton variant="ghost" type="button" (click)="editing.set(null)">Cancel</button>
                </div>
              </form>
            } @else {
              <div class="actions">
                <button mkButton variant="ghost" size="sm" [disabled]="!!n.pending" (click)="edit(i)"><mk-icon name="settings" size="sm" /> Change</button>
              </div>
            }
          </section>
        }

        <app-tunnel-card />
      }
    </app-storage>
  `,
  styles: [
    `
      .alert {
        display: block;
        margin-bottom: var(--mk-space-4);
      }
      .note {
        margin: 0 0 var(--mk-space-3);
      }
      .card {
        display: grid;
        gap: var(--mk-space-3);
        padding: var(--mk-space-4);
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-lg);
        margin-bottom: var(--mk-space-4);
      }
      h2 {
        margin: 0;
        font-size: var(--mk-font-size-lg);
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
      }
      .spacer {
        flex: 1;
      }
      .form {
        display: grid;
        gap: var(--mk-space-3);
      }
      .row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--mk-space-3);
        align-items: end;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
      .small {
        font-size: var(--mk-font-size-xs);
        margin: 0;
      }
    `,
  ],
})
export class StorageNetworkPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly revertAfter = REVERT_AFTER;
  protected readonly q = loader<Network>(() => this.api.nas.network());
  protected readonly busy = signal(false);
  protected readonly hostname = signal('');
  protected readonly editing = signal<string | null>(null);
  protected readonly dhcp = signal(true);
  protected readonly address = signal('');
  protected readonly gateway = signal('');
  protected readonly dns = signal('');
  /** The address the last Apply asked for, so the banner can link to it even after the old one stopped answering. */
  protected readonly applied = signal<string | null>(null);
  private readonly now = signal(Date.now());

  protected readonly hostnameValid = computed(() => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(this.hostname()));
  protected readonly formValid = computed(
    () =>
      this.dhcp() ||
      (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(this.address().trim()) &&
        (this.gateway().trim() === '' || /^\d{1,3}(\.\d{1,3}){3}$/.test(this.gateway().trim())) &&
        this.dnsList().every((d) => /^\d{1,3}(\.\d{1,3}){3}$/.test(d)) &&
        this.dnsList().length <= 3),
  );
  protected readonly secondsLeft = computed(() => {
    const p = this.q.data()?.pending;
    return p ? Math.max(0, Math.round((ms(p.expiresAt) - this.now()) / 1000)) : 0;
  });
  protected readonly newUrl = computed(() => {
    const ip = this.applied();
    return ip ? `${location.protocol}//${ip}${location.port ? ':' + location.port : ''}/storage/network` : null;
  });

  constructor() {
    void this.q.run().then(() => this.hostname.set(this.q.data()?.hostname ?? ''));
    // the countdown, and a reload once it runs out (the agent reverts on its own; the page should show it)
    const timer = setInterval(() => {
      this.now.set(Date.now());
      const p = this.q.data()?.pending;
      if (p && ms(p.expiresAt) < Date.now() - 2000) void this.q.run();
    }, 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  localUrl(n: Network): string {
    return `${location.protocol}//${n.hostname}.local${location.port ? ':' + location.port : ''}/storage/network`;
  }

  via(i: NetInterface): string {
    if (i.configured) return i.configured.dhcp ? 'DHCP, set here' : 'static, set here';
    return i.dhcp ? 'DHCP' : i.addresses.length ? 'static, from the installer' : 'not configured';
  }

  dnsList(): string[] {
    return this.dns()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  edit(i: NetInterface): void {
    const c = i.configured;
    this.dhcp.set(c ? c.dhcp : i.dhcp || i.addresses.length === 0);
    this.address.set(c && !c.dhcp ? c.address : (i.addresses[0] ?? ''));
    this.gateway.set(c && !c.dhcp ? (c.gateway ?? '') : (this.q.data()?.gateway ?? ''));
    this.dns.set(c && !c.dhcp ? c.dns.join(', ') : (this.q.data()?.dns ?? []).join(', '));
    this.editing.set(i.name);
  }

  async setHostname(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.hostnameValid()) return;
    this.busy.set(true);
    try {
      const n = await this.api.nas.setNetwork({ hostname: this.hostname().trim() });
      this.toast.success(`The box is now ${n.hostname}${n.mdns ? ` (${n.hostname}.local)` : ''}`);
      await this.q.run();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async apply(ev: Event, i: NetInterface): Promise<void> {
    ev.preventDefault();
    if (!this.formValid()) return;
    const ok = await this.dialog.confirm({
      title: `Change ${i.name} now?`,
      message: this.dhcp()
        ? `${i.name} asks the router for an address. Find the box at its new address (or ${this.q.data()?.hostname}.local) and press Keep within ${REVERT_AFTER} s, or it goes back.`
        : `${i.name} becomes ${this.address().trim()}. Open the drive there and press Keep within ${REVERT_AFTER} s, or it goes back.`,
      confirmText: 'Apply',
      tone: 'danger',
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      const args = this.dhcp()
        ? { interface: i.name, dhcp: true as const }
        : { interface: i.name, address: this.address().trim(), gateway: this.gateway().trim() || null, dns: this.dnsList() };
      this.applied.set(this.dhcp() ? null : this.address().trim().split('/')[0]);
      const n = await this.api.nas.setNetwork({ ...args, revertAfter: REVERT_AFTER });
      this.editing.set(null);
      this.q.data.set(n);
    } catch (e) {
      // the request itself may have died with the old address; the box has the change either way
      this.toast.warning(`${errorMessage(e)} — if the box moved, open it at the new address and press Keep there`);
      await this.q.run().catch(() => {});
    } finally {
      this.busy.set(false);
    }
  }

  async keep(): Promise<void> {
    this.busy.set(true);
    try {
      const n = await this.api.nas.confirmNetwork();
      this.q.data.set(n);
      this.toast.success('The address stays');
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
