import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MK_OVERLAY_DATA, MkOverlayRef } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkDescItem, MkDescriptionList, MkProgressBar, MkTag } from '@mk-kit/ui/data';
import { MkDialog, MkToastService } from '@mk-kit/ui/feedback';
import { MkSpinner } from '@mk-kit/ui/status';
import type { Disk, Smart } from '../../../../../shared/nas';
import { ApiService, errorMessage } from '../../core/api.service';

interface Attr {
  id: number;
  name: string;
  value: number;
  worst: number;
  thresh: number;
  raw: { value: number; string?: string };
}

/** What smartctl says about one disk: the summary, the self-tests (start one here), then the attribute table as it is. */
@Component({
  selector: 'app-smart-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkDialog, MkButton, MkDescriptionList, MkDescItem, MkSpinner, MkProgressBar, MkTag],
  template: `
    <mk-dialog [dialogTitle]="data.model ?? data.id">
      @if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (!smart()) {
        <mk-spinner />
      } @else if (smart(); as s) {
        <mk-description-list layout="grid">
          <mk-desc-item term="Disk"
            ><span class="mono">{{ s.id }}</span></mk-desc-item
          >
          <mk-desc-item term="Serial"
            ><span class="mono">{{ s.serial ?? '—' }}</span></mk-desc-item
          >
          <mk-desc-item term="Firmware">{{ s.firmware ?? '—' }}</mk-desc-item>
          <mk-desc-item term="Self-assessment">{{ s.passed === null ? 'unknown' : s.passed ? 'passed' : 'FAILED' }}</mk-desc-item>
          <mk-desc-item term="Temperature">{{ s.temperature === null ? '—' : s.temperature + ' °C' }}</mk-desc-item>
          <mk-desc-item term="Powered on">{{ s.powerOnHours === null ? '—' : hours(s.powerOnHours) }}</mk-desc-item>
          @if (s.wear !== null) {
            <mk-desc-item term="Worn">{{ s.wear }}%</mk-desc-item>
          }
          @if (s.reallocated !== null) {
            <mk-desc-item term="Reallocated sectors">{{ s.reallocated }}</mk-desc-item>
          }
          @if (s.pending !== null) {
            <mk-desc-item term="Pending sectors">{{ s.pending }}</mk-desc-item>
          }
        </mk-description-list>
        <section class="tests">
          <div class="tests__head">
            <h3>Self-tests</h3>
            <span class="spacer"></span>
            @if (s.selfTest.running; as r) {
              <span class="muted small">{{ r.kind }} test running</span>
            } @else {
              <button mkButton variant="ghost" size="sm" [loading]="busy()" (click)="test('short')">Short test</button>
              <button mkButton variant="ghost" size="sm" [loading]="busy()" (click)="test('long')">Long test</button>
            }
          </div>
          @if (s.selfTest.running; as r) {
            <mk-progress-bar [value]="r.percentDone ?? 0" [indeterminate]="r.percentDone === null" size="sm" tone="info" showValue />
          }
          @if (s.selfTest.tests.length) {
            <ul class="tests__list">
              @for (t of s.selfTest.tests; track $index) {
                <li class="tests__row">
                  <mk-tag size="sm" [tone]="t.passed === false ? 'danger' : t.passed ? 'success' : 'neutral'">{{ t.kind }}</mk-tag>
                  <span>{{ t.result }}</span>
                  @if (t.hours !== null) {
                    <span class="muted small">at {{ t.hours }} h</span>
                  }
                </li>
              }
            </ul>
          } @else if (!s.selfTest.running) {
            <p class="muted small">
              None on record. A short test takes minutes; a long one reads the whole disk and takes hours. The NAS runs a long one monthly by itself.
            </p>
          }
        </section>
        @if (attrs().length) {
          <div class="scroll">
            <table class="attrs">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Attribute</th>
                  <th class="num">Value</th>
                  <th class="num">Worst</th>
                  <th class="num">Thresh</th>
                  <th class="num">Raw</th>
                </tr>
              </thead>
              <tbody>
                @for (a of attrs(); track a.id) {
                  <tr [class.bad]="a.thresh > 0 && a.value <= a.thresh">
                    <td class="mono">{{ a.id }}</td>
                    <td>{{ a.name }}</td>
                    <td class="num">{{ a.value }}</td>
                    <td class="num">{{ a.worst }}</td>
                    <td class="num">{{ a.thresh }}</td>
                    <td class="num mono">{{ a.raw.string ?? a.raw.value }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (nvme(); as n) {
          <div class="scroll">
            <table class="attrs">
              <tbody>
                @for (kv of n; track kv[0]) {
                  <tr>
                    <td>{{ kv[0] }}</td>
                    <td class="num mono">{{ kv[1] }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
      <div mkDialogFooter class="footer">
        <button mkButton variant="ghost" type="button" (click)="ref.close()">Close</button>
      </div>
    </mk-dialog>
  `,
  styles: [
    `
      .error {
        color: var(--mk-danger);
      }
      .scroll {
        overflow-x: auto;
        margin-top: var(--mk-space-4);
      }
      .attrs {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--mk-font-size-sm);
      }
      .attrs th,
      .attrs td {
        text-align: left;
        padding: var(--mk-space-1) var(--mk-space-2);
        border-bottom: 1px solid var(--mk-border-subtle);
      }
      .attrs th {
        color: var(--mk-text-muted);
        font-weight: 500;
      }
      .num {
        text-align: right !important;
        white-space: nowrap;
      }
      .bad td {
        color: var(--mk-danger);
      }
      .tests {
        margin-top: var(--mk-space-4);
        display: grid;
        gap: var(--mk-space-2);
      }
      .tests__head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
      }
      .tests__head h3 {
        margin: 0;
        font-size: var(--mk-font-size-md);
      }
      .spacer {
        flex: 1;
      }
      .tests__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .tests__row {
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
export class SmartDialog {
  protected readonly data = inject<Disk>(MK_OVERLAY_DATA);
  protected readonly ref = inject<MkOverlayRef<void>>(MkOverlayRef);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  protected readonly smart = signal<Smart | null>(null);
  protected readonly busy = signal(false);
  protected readonly attrs = signal<Attr[]>([]);
  protected readonly nvme = signal<[string, unknown][] | null>(null);
  protected readonly error = signal('');

  constructor() {
    void this.api.nas
      .smart(this.data.id)
      .then((s) => {
        this.smart.set(s);
        const raw = s.raw as { ata_smart_attributes?: { table?: Attr[] }; nvme_smart_health_information_log?: Record<string, unknown> };
        this.attrs.set(raw.ata_smart_attributes?.table ?? []);
        if (raw.nvme_smart_health_information_log)
          this.nvme.set(Object.entries(raw.nvme_smart_health_information_log).map(([k, v]) => [k.replaceAll('_', ' '), v]));
      })
      .catch((e) => this.error.set(errorMessage(e)));
  }

  async test(kind: 'short' | 'long'): Promise<void> {
    this.busy.set(true);
    try {
      this.smart.set(await this.api.nas.smartTest(this.data.id, kind));
      this.toast.success(`${kind === 'short' ? 'Short' : 'Long'} self-test started on ${this.data.id}`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  hours(h: number): string {
    const days = h / 24;
    return days >= 365 ? `${(days / 365).toFixed(1)} years` : days >= 60 ? `${Math.round(days / 30)} months` : `${Math.round(days)} days`;
  }
}
