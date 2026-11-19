import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type { ContextUsage, ModelOption, SessionCounts, SessionSpeed, TokenUsage } from '@morse/protocol';
import {
  cacheHitRate,
  formatCost,
  formatRate,
  formatTokens,
  formatUsage,
  formatUsageValue,
} from '@morse/ui-runtime';
import { placeUsagePanel, type Box } from './usage-panel';

const RADIUS = 15.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A compact context-window indicator for the composer: a small progress ring
 * that opens into a full usage panel on click — the ring is the glance, the
 * panel is the detail.
 *
 * Two panels in one component, because they answer two different questions. A
 * code session is the reader's own run of work, so it reports the whole
 * economics: messages, cache, speed, cost. A bot conversation has one engine
 * session per bot, so its numbers are that bot's and only partly known — what
 * matters there is the budget, so `variant: 'context'` draws used and remaining
 * tokens and nothing else. Same ring, same popup, no second component.
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
  readonly speed = input<SessionSpeed>();
  readonly model = input<ModelOption>();
  readonly sessionTitle = input<string>();
  /**
   * How much the panel says: `full` is a code session's whole economics, and
   * `context` is only the window — used, remaining, and the limit it is measured
   * against, which is all a bot's counters can honestly offer.
   */
  readonly variant = input<'full' | 'context'>('full');

  protected readonly open = signal(false);
  protected readonly circumference = CIRCUMFERENCE;

  /** Where the panel sits, in px from the trigger's own left edge. */
  protected readonly panelLeft = signal(0);
  /** The most the panel may be wide and tall, so it stays in the pane it is in. */
  protected readonly panelWidth = signal(320);
  protected readonly panelHeight = signal(320);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** A panel anchored to a trigger that scrolls away follows it, or closes. */
  private readonly onScroll = (): void => this.place();
  private readonly onResize = (): void => this.place();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('scroll', this.onScroll, true);
      window.removeEventListener('resize', this.onResize);
    });
  }

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

  /**
   * What is left of the window. `null` tokens means the engine has not said —
   * right after a compaction it reports nothing until the next turn — so the
   * remainder is unknown rather than assumed to be the whole window.
   */
  protected readonly remainingLabel = computed(() => {
    const usage = this.contextUsage();
    if (usage === undefined || usage.tokens === null || usage.tokens === undefined) {
      return '—';
    }
    return formatTokens(Math.max(0, usage.contextWindow - usage.tokens));
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
    const lines: string[] = [
      `Context ${this.percentLabel()} · ${this.usedLabel()} / ${this.limitLabel()}`,
    ];
    if (this.variant() === 'context') {
      // A bot's panel offers the budget alone, so the ring's tooltip does too —
      // printing a cost or a cache total here would reintroduce what the panel
      // deliberately leaves out.
      lines.push(`Remaining ${this.remainingLabel()}`);
      return lines.join('\n');
    }
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

  /** Prompt tokens the cache served, whole session; `—` when none was reported. */
  protected readonly cachedLabel = computed(() =>
    formatUsageValue(this.usage(), 'cacheReadTokens'),
  );

  /** Prompt tokens the cache missed (pi's `input` excludes every cache figure). */
  protected readonly missLabel = computed(() => {
    const usage = this.usage();
    return usage === undefined ? '—' : formatTokens(usage.inputTokens);
  });

  protected readonly avgSpeedLabel = computed(() =>
    formatRate(this.speed()?.avgTokensPerSecond),
  );

  protected readonly peakSpeedLabel = computed(() =>
    formatRate(this.speed()?.peakTokensPerSecond),
  );

  protected readonly slowestSpeedLabel = computed(() =>
    formatRate(this.speed()?.slowestTokensPerSecond),
  );

  protected lastValue(key: keyof TokenUsage): string {
    return formatUsageValue(this.lastUsage(), key);
  }

  protected toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    // Placed before the first render, so the panel never draws in the old spot and
    // then jumps: the maths needs the trigger, which is already laid out.
    this.place();
    this.open.set(true);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onResize);
  }

  protected close(): void {
    if (!this.open()) {
      return;
    }
    this.open.set(false);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onResize);
  }

  /**
   * Puts the panel inside the pane that can actually show it.
   *
   * The trigger can sit inside a scrolling region — a bot's live row in the
   * transcript — and a popup hung to its left lands on the pane's very edge
   * there, right where the sidebar begins, and reads as clipped by it. So the
   * pane is measured and the panel is placed against it: centred over the ring
   * when that fits, hanging left when it does not, and always inside.
   */
  private place(): void {
    const anchor = this.host.nativeElement.getBoundingClientRect();
    const clip = this.clipBox();
    // The trigger itself left what can show the panel (its row scrolled away):
    // there is nothing left to point at, so it closes instead of floating at an
    // edge with no origin.
    if (anchor.bottom < clip.top || anchor.top > clip.bottom) {
      this.close();
      return;
    }
    const placed = placeUsagePanel(
      { left: anchor.left, right: anchor.right, top: anchor.top, bottom: anchor.bottom },
      clip,
    );
    this.panelLeft.set(placed.left);
    this.panelWidth.set(placed.width);
    this.panelHeight.set(placed.height);
  }

  /**
   * The box the panel may occupy: the nearest ancestor that clips its content,
   * or the window. The panel is absolutely positioned, so an ancestor with
   * `overflow` is what would cut it off.
   */
  private clipBox(): Box {
    for (let node = this.host.nativeElement.parentElement; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clips = (value: string): boolean => value !== '' && value !== 'visible';
      if (clips(style.overflowX) || clips(style.overflowY)) {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }
    }
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  }
}
