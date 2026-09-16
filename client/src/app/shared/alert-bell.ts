import { ChangeDetectionStrategy, Component, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { MkNotificationCenter, type MkNotification } from '@mk-kit/ui/feedback';
import type { Alert, Alerts } from '../../../../shared/nas';
import { AlertsService, severityWord } from '../core/alerts.service';
import { DriveService } from '../core/drive.service';
import { ago } from '../core/format';
import { ms } from '../pages/storage/load';

/** One alert as the kit's notification model: the severity leads the title, "unread" means open and not acknowledged. */
function toItem(a: Alert, cleared: boolean): MkNotification {
  return {
    id: cleared ? `cleared:${a.key}` : a.key,
    title: `${severityWord[a.severity]} · ${a.title}`,
    body: cleared ? `Cleared ${ago(ms(a.clearedAt))}${a.detail ? ' · ' + a.detail : ''}` : (a.detail ?? undefined),
    time: cleared ? ago(ms(a.clearedAt)) : ago(ms(a.since)),
    read: cleared || !!a.ackedAt,
  };
}

function toItems(al: Alerts | null): MkNotification[] {
  if (!al) return [];
  return [...al.open.map((a) => toItem(a, false)), ...al.recent.map((a) => toItem(a, true))];
}

/**
 * The bell in the header: what the box says is wrong, unread until it is
 * acknowledged. Only in NAS mode and only for an admin — the drive has nothing
 * else to notify about yet — and only once the box has answered, so an agent
 * older than the alerts verb leaves the header as it was. Reading a row
 * acknowledges that alert on the box; clicking it goes to the Storage overview.
 */
@Component({
  selector: 'app-alert-bell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkNotificationCenter],
  template: `
    @if (drive.nas() && alerts.data()) {
      <mk-notification-center
        [(notifications)]="items"
        panelTitle="What the box says"
        emptyText="Nothing is wrong."
        maxHeight="60vh"
        (itemClick)="open()"
        (read)="ack($event)"
        (markedAllRead)="ackAll()"
      />
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
    `,
  ],
})
export class AlertBell {
  protected readonly drive = inject(DriveService);
  protected readonly alerts = inject(AlertsService);
  private readonly router = inject(Router);
  private readonly centre = viewChild(MkNotificationCenter);
  /** The kit's two-way list; the box's answer is the truth and overwrites it on every load. */
  protected readonly items = signal<MkNotification[]>([]);
  /** The first load, once NAS mode is known; after that the panel and the overview refresh it. */
  private asked = false;

  constructor() {
    effect(() => this.items.set(toItems(this.alerts.data())));
    // opening the panel is the moment to be current; the Storage overview keeps it fresh while it is open
    effect(() => {
      if (this.centre()?.open()) void this.alerts.load();
    });
    effect(() => {
      if (this.drive.nas() && !this.asked) {
        this.asked = true;
        void this.alerts.load();
      }
    });
  }

  protected open(): void {
    void this.router.navigateByUrl('/storage/overview');
  }

  /** A row was read: that is what acknowledging means here. */
  protected ack(item: MkNotification): void {
    const id = String(item.id);
    if (!id.startsWith('cleared:')) void this.alerts.ack(id);
  }

  protected ackAll(): void {
    void (async () => {
      for (const a of this.alerts.unacked()) await this.alerts.ack(a.key);
    })();
  }
}
