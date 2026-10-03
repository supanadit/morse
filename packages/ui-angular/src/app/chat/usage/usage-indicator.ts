import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { ContextUsage, ModelOption, SessionCounts, TokenUsage } from '@morse/protocol';
import {
  cacheHitRate,
  formatCost,
  formatTokens,
  formatUsage,
} from '../../core/usage-format';

const RADIUS = 15.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A compact context-window indicator for the composer: a small progress ring
 * that opens into a full usage panel on click — the ring is the glance, the
 * panel is the detail.
 */
@Component({
  selector: 'morse-usage-indicator',
  templateUrl: './usage-indicator.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'close()',
  },
  styles: [
    `
      :host {
        position: relative;
        display: inline-flex;
        vertical-align: middle;
      }
      .mini {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 7px 2px 3px;
        border: 1px solid transparent;
        border-radius: 999px;
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
      }
      .mini:hover,
      .mini[aria-expanded='true'] {
        border-color: var(--morse-border);
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .ring {
        width: 20px;
        height: 20px;
        transform: rotate(-90deg);
      }
      .track {
        fill: none;
        stroke: var(--morse-border);
        stroke-width: 3.4;
      }
      .value {
        fill: none;
        stroke: var(--morse-success);
        stroke-width: 3.4;
        stroke-linecap: round;
        transition: stroke-dashoffset 300ms ease;
      }
      .ring.warn .value {
        stroke: var(--morse-warn);
      }
      .ring.danger .value {
        stroke: var(--morse-error);
      }
      .pct {
        font-family: var(--morse-font-mono);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .scrim {
        position: fixed;
        inset: 0;
        z-index: 30;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: default;
      }
      /*
       * The scrim is a button so it can be clicked and focused, but it must never
       * take a button's hover colour: VS Code injects button:hover rules into
       * the webview and the global one in styles.css would paint the whole
       * viewport in the theme's accent colour (green) whenever the pointer leaves
       * the panel. The scoped attribute selector wins that specificity fight.
       */
      .scrim:hover,
      .scrim:active {
        background: transparent;
      }
      .panel {
        position: absolute;
        z-index: 31;
        right: 0;
        bottom: calc(100% + 8px);
        width: 320px;
        max-height: 70vh;
        overflow-y: auto;
        padding: 12px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 16px 40px rgb(0 0 0 / 35%);
        color: var(--morse-fg);
        text-align: left;
      }
      .panel header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 2px;
      }
      .panel h3 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .close {
        padding: 0 6px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 15px;
        line-height: 1.4;
        cursor: pointer;
      }
      .close:hover {
        color: var(--morse-fg);
        background: var(--morse-active);
      }
      .subtitle {
        margin-bottom: 10px;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .bar-head,
      .bar-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .bar {
        height: 7px;
        margin: 5px 0;
        border-radius: 999px;
        background: var(--morse-border);
        overflow: hidden;
      }
      .bar .fill {
        display: block;
        height: 100%;
        border-radius: 999px;
        background: var(--morse-success);
        transition: width 300ms ease;
      }
      .bar .fill.warn {
        background: var(--morse-warn);
      }
      .bar .fill.danger {
        background: var(--morse-error);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-top: 10px;
      }
      .cell {
        padding: 6px 8px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg, transparent);
      }
      .cell .k {
        display: block;
        color: var(--morse-fg-muted);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .cell .v {
        display: block;
        margin-top: 2px;
        font-family: var(--morse-font-mono);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      section {
        margin-top: 12px;
      }
      section h4 {
        margin: 0 0 4px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .totals {
        padding: 7px 9px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class UsageIndicator {
  readonly usage = input<TokenUsage>();
  readonly lastUsage = input<TokenUsage>();
  readonly costUsd = input<number>();
  readonly contextUsage = input<ContextUsage>();
  readonly counts = input<SessionCounts>();
  readonly model = input<ModelOption>();
  readonly sessionTitle = input<string>();

  protected readonly open = signal(false);
  protected readonly circumference = CIRCUMFERENCE;

  private readonly percent = computed(() => this.contextUsage()?.percent ?? undefined);

  protected readonly percentLabel = computed(() => {
    const percent = this.contextUsage()?.percent;
    return percent === null || percent === undefined ? '–' : `${percent.toFixed(1)}%`;
  });

  protected readonly level = computed<'ok' | 'warn' | 'danger'>(() => {
    const percent = this.percent() ?? 0;
    return percent > 90 ? 'danger' : percent > 70 ? 'warn' : 'ok';
  });

  protected readonly fillPercent = computed(() =>
    Math.min(100, Math.max(0, this.percent() ?? 0)),
  );

  protected readonly dashOffset = computed(
    () => CIRCUMFERENCE * (1 - this.fillPercent() / 100),
  );

  protected readonly usedLabel = computed(() => {
    const tokens = this.contextUsage()?.tokens;
    return tokens === null || tokens === undefined ? '—' : formatTokens(tokens);
  });

  protected readonly limitLabel = computed(() => {
    const window = this.contextUsage()?.contextWindow;
    return window === undefined ? '—' : formatTokens(window);
  });

  protected readonly costLabel = computed(() => formatCost(this.costUsd()) ?? '—');

  protected readonly outputLimitLabel = computed(() => {
    const max = this.model()?.maxTokens;
    return max === undefined ? '—' : formatTokens(max);
  });

  protected readonly modelLabel = computed(
    () => this.model()?.name ?? this.model()?.id ?? 'no model',
  );

  /** Tooltip on the ring: the whole footer, without opening the panel. */
  protected readonly tooltip = computed(() => {
    const lines: string[] = [`Context ${this.percentLabel()} · ${this.usedLabel()} / ${this.limitLabel()}`];
    const summary = formatUsage({
      usage: this.usage(),
      costUsd: this.costUsd(),
      contextUsage: this.contextUsage(),
    });
    if (summary.length > 0) {
      lines.push(summary);
    }
    return lines.join('\n');
  });

  protected readonly sessionLine = computed(() =>
    formatUsage({
      usage: this.usage(),
      costUsd: this.costUsd(),
      contextUsage: this.contextUsage(),
    }),
  );

  protected readonly cacheHitLabel = computed(() => {
    const hit = cacheHitRate(this.lastUsage());
    return hit === undefined ? '—' : `${hit.toFixed(1)}%`;
  });

  protected lastValue(key: keyof TokenUsage): string {
    const usage = this.lastUsage();
    if (!usage) {
      return '—';
    }
    return formatTokens((usage[key] as number | undefined) ?? 0);
  }

  protected toggle(): void {
    this.open.update((value) => !value);
  }

  protected close(): void {
    this.open.set(false);
  }
}
