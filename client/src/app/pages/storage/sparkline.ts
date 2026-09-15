import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ago } from '../../core/format';
import { ms } from './load';

/**
 * Half an hour of one number, as a line in the tile's own colour: no axis,
 * no legend (the tile names the series), a dot on the newest point, and the
 * value under the pointer when someone looks closer.
 */
@Component({
  selector: 'app-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (path(); as p) {
      <div class="spark" (mousemove)="hover($event)" (mouseleave)="at.set(null)">
        <svg viewBox="0 0 120 28" preserveAspectRatio="none" [attr.aria-label]="label()" role="img">
          <path
            [attr.d]="p"
            fill="none"
            stroke="var(--mk-primary)"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
          @if (cursor(); as c) {
            <line [attr.x1]="c.x" [attr.x2]="c.x" y1="0" y2="28" stroke="var(--mk-border)" stroke-width="1" vector-effect="non-scaling-stroke" />
          }
        </svg>
        @if (last(); as l) {
          <span class="spark__dot" [style.left.%]="l.x" [style.top.%]="l.y"></span>
        }
        @if (read(); as r) {
          <span class="spark__read">{{ r }}</span>
        }
      </div>
    }
  `,
  styles: [
    `
      .spark {
        position: relative;
        height: 28px;
        margin-top: var(--mk-space-2);
      }
      svg {
        width: 100%;
        height: 100%;
        display: block;
        overflow: visible;
      }
      .spark__dot {
        position: absolute;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--mk-primary);
        border: 2px solid var(--mk-surface);
        transform: translate(-50%, -50%);
        pointer-events: none;
      }
      .spark__read {
        position: absolute;
        right: 0;
        top: -1.4em;
        font-size: var(--mk-font-size-xs);
        color: var(--mk-text-muted);
        background: var(--mk-surface);
        padding: 0 4px;
        pointer-events: none;
      }
    `,
  ],
})
export class Sparkline {
  /** Oldest first. */
  readonly values = input.required<(number | null)[]>();
  readonly times = input<string[]>([]);
  readonly format = input<(v: number) => string>((v) => String(Math.round(v)));
  readonly label = input('');
  protected readonly at = signal<number | null>(null);

  private readonly scaled = computed(() => {
    const vs = this.values();
    const pts = vs.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null && Number.isFinite(p.v));
    if (pts.length < 2) return null;
    const max = Math.max(...pts.map((p) => p.v), 0);
    const min = Math.min(...pts.map((p) => p.v), 0);
    const span = max - min || 1;
    const n = vs.length - 1;
    return pts.map((p) => ({ i: p.i, v: p.v, x: (p.i / n) * 120, y: 26 - ((p.v - min) / span) * 24 }));
  });
  protected readonly path = computed(() => {
    const s = this.scaled();
    return s ? s.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') : null;
  });
  protected readonly last = computed(() => {
    const s = this.scaled();
    const p = s?.at(-1);
    return p ? { x: (p.x / 120) * 100, y: (p.y / 28) * 100 } : null;
  });
  protected readonly cursor = computed(() => {
    const s = this.scaled();
    const i = this.at();
    if (!s || i === null) return null;
    return s.reduce((a, b) => (Math.abs(b.i - i) < Math.abs(a.i - i) ? b : a));
  });
  protected readonly read = computed(() => {
    const c = this.cursor();
    if (!c) return null;
    const t = this.times()[c.i];
    return `${this.format()(c.v)}${t ? ` · ${ago(ms(t))}` : ''}`;
  });

  hover(ev: MouseEvent): void {
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const n = this.values().length - 1;
    if (n < 1 || r.width === 0) return;
    this.at.set(Math.round(((ev.clientX - r.left) / r.width) * n));
  }
}
