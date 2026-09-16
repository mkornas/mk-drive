import { Injectable, computed, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import type { NotifySettings, NotifySettingsInput } from '../../../../shared/types';
import { ApiService, errorMessage } from './api.service';

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** Why push cannot work in this browser, in words for the person; null when it can. */
export function pushBlocker(swEnabled: boolean): string | null {
  if (!window.isSecureContext) return 'Notifications need HTTPS — open the drive through its public address, not the plain LAN port.';
  if (!('serviceWorker' in navigator)) return 'This browser has no service worker support, so it cannot receive push notifications.';
  if (isIos() && !isStandalone())
    return 'On iPhone and iPad, add the drive to the Home Screen first (Share → Add to Home Screen) and open it from there — Safari only allows notifications for installed apps.';
  if (typeof Notification === 'undefined' || !('PushManager' in window)) return 'This browser does not support web push notifications.';
  if (!swEnabled) return 'The service worker is not active yet — reload the page once and try again.';
  return null;
}

/**
 * Web push for this browser: the browser's subscription is registered with the
 * drive, which sends what the account asked to be woken for. Needs HTTPS (the
 * service worker needs a secure context) and a server with its signing keys.
 * Nothing here throws at a template: every failure lands in `blocker`/`error`.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly sw = inject(SwPush);
  private readonly api = inject(ApiService);

  /** This browser could receive a push, as far as the browser is concerned. */
  readonly supported = signal(this.sw.isEnabled && typeof Notification !== 'undefined' && 'PushManager' in window);
  readonly blocker = signal<string | null>(pushBlocker(this.sw.isEnabled));
  readonly permission = signal<NotificationPermission>(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  /** This browser has a push subscription. */
  readonly subscribed = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** What the account has set; null until the first load, or when it could not be read. */
  readonly settings = signal<NotifySettings | null>(null);

  readonly devices = computed(() => this.settings()?.devices ?? []);
  /** The server can send at all (it has its signing keys); null until known. */
  readonly serverReady = computed<boolean | null>(() => this.settings()?.supported ?? null);
  /** Push can be turned on here: the browser allows it and the server can send. */
  readonly available = computed(() => !this.blocker() && this.serverReady() !== false);

  private subscription: PushSubscription | null = null;

  constructor() {
    if (this.supported()) {
      this.sw.subscription.subscribe((s) => {
        this.subscription = s;
        this.subscribed.set(!!s);
      });
    }
  }

  /** Load the account's settings; never throws, a failure leaves `settings` null. */
  async refresh(): Promise<NotifySettings | null> {
    try {
      const s = await this.api.notifications.get();
      this.settings.set(s);
      return s;
    } catch (e) {
      this.error.set(errorMessage(e));
      return null;
    }
  }

  /** Turn push on or off for this browser; returns whether it is on afterwards. */
  async toggle(): Promise<boolean> {
    return this.subscribed() ? this.disable() : this.enable();
  }

  /** Ask the browser, then register the subscription with the drive. `error` says why not. */
  async enable(): Promise<boolean> {
    this.error.set(null);
    const blocked = this.blocker();
    if (blocked) {
      this.error.set(blocked);
      return false;
    }
    this.busy.set(true);
    try {
      const s = this.settings() ?? (await this.api.notifications.get());
      this.settings.set(s);
      if (!s.supported || !s.publicKey) throw new Error('This drive cannot send notifications yet — it has no signing keys.');
      const sub = await this.sw.requestSubscription({ serverPublicKey: s.publicKey });
      this.permission.set(Notification.permission);
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser gave an incomplete subscription.');
      this.settings.set(await this.api.notifications.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }));
      this.subscription = sub;
      this.subscribed.set(true);
      return true;
    } catch (e) {
      this.permission.set(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
      this.error.set(this.permission() === 'denied' ? 'Notifications are blocked for this site in the browser’s settings.' : errorMessage(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Drop this browser's subscription, here and on the drive; returns whether push is on afterwards. */
  async disable(): Promise<boolean> {
    this.error.set(null);
    this.busy.set(true);
    try {
      const endpoint = this.subscription?.endpoint;
      await this.sw.unsubscribe().catch(() => undefined);
      this.subscription = null;
      this.subscribed.set(false);
      if (endpoint) this.settings.set(await this.api.notifications.unsubscribe(endpoint));
      else await this.refresh();
      return false;
    } catch (e) {
      this.error.set(errorMessage(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Forget another browser of this account. */
  async forget(id: number): Promise<boolean> {
    this.error.set(null);
    try {
      this.settings.set(await this.api.notifications.forget(id));
      return true;
    } catch (e) {
      this.error.set(errorMessage(e));
      return false;
    }
  }

  /** How loud something has to be, and whether the NAS alerts count. */
  async save(input: NotifySettingsInput): Promise<boolean> {
    this.error.set(null);
    try {
      this.settings.set(await this.api.notifications.set(input));
      return true;
    } catch (e) {
      this.error.set(errorMessage(e));
      return false;
    }
  }

  /** Send one push to every browser of this account; the count sent, or null when it failed. */
  async test(): Promise<number | null> {
    this.error.set(null);
    this.busy.set(true);
    try {
      return (await this.api.notifications.test()).sent;
    } catch (e) {
      this.error.set(errorMessage(e));
      return null;
    } finally {
      this.busy.set(false);
    }
  }
}
