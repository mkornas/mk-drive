import { Injectable, computed, inject, signal } from '@angular/core';
import type { Alerts } from '../../../../shared/nas';
import { ApiService } from './api.service';
import { DriveService } from './drive.service';

/**
 * What the box says is wrong, shared by the header's bell and the Storage
 * overview so both read one answer. Only asked for in NAS mode, and only by an
 * admin; an agent that does not know the verb yet leaves `unavailable` set and
 * the overview falls back to `health.problems`.
 */
@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly api = inject(ApiService);
  private readonly drive = inject(DriveService);

  readonly data = signal<Alerts | null>(null);
  readonly loading = signal(false);
  /** The route or the agent does not have alerts (older mk-nas, or no socket). */
  readonly unavailable = signal(false);

  readonly open = computed(() => this.data()?.open ?? []);
  readonly recent = computed(() => this.data()?.recent ?? []);
  readonly worst = computed(() => this.data()?.worst ?? null);
  /** Open and not acknowledged: what the bell counts. */
  readonly unacked = computed(() => this.open().filter((a) => !a.ackedAt));

  /** Never throws: a failure only marks the alerts unavailable. */
  async load(): Promise<void> {
    if (!this.drive.nas()) {
      this.unavailable.set(true);
      return;
    }
    this.loading.set(true);
    try {
      this.data.set(await this.api.nas.alerts());
      this.unavailable.set(false);
    } catch {
      this.data.set(null);
      this.unavailable.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Say it has been seen: it stays open but stops nagging. */
  async ack(key: string): Promise<boolean> {
    try {
      this.data.set(await this.api.nas.ackAlert(key));
      return true;
    } catch {
      return false;
    }
  }
}

/** The severity as a word, and as a tone for the kit's tags and alerts. */
export const severityWord = { critical: 'Critical', warning: 'Warning', info: 'Notice' } as const;
export const severityTone = { critical: 'danger', warning: 'warning', info: 'info' } as const;
