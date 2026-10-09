import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { ContextUsage, ModelOption, SessionCounts, TokenUsage } from '@morse/protocol';
import {
  cacheHitRate,
  formatCost,
  formatTokens,
  formatUsage,
  formatUsageValue,
} from '@morse/ui-runtime';

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
  styleUrl: './usage-indicator.css',
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
    return formatUsageValue(this.lastUsage(), key);
  }

  protected toggle(): void {
    this.open.update((value) => !value);
  }

  protected close(): void {
    this.open.set(false);
  }
}
