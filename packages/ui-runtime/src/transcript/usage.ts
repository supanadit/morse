import type { ContextUsage, TokenUsage } from '@morse/protocol';

/** Compact token counts, same thresholds as pi's footer. */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return count.toString();
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`;
  }
  if (count < 10_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(count / 1_000_000)}M`;
}

/**
 * One cell of the "last assistant message" grid. A field the provider did not
 * report reads as `—`, not `0`: pi coerces a missing reasoning breakdown to 0,
 * so `0` would claim the model did not think when the truth is that nobody
 * counted it. Same honesty rule as `cacheHitRate`.
 */
export function formatUsageValue(usage: TokenUsage | undefined, key: keyof TokenUsage): string {
  const value = usage?.[key];
  return typeof value === 'number' ? formatTokens(value) : '—';
}

/**
 * Prompt-cache efficiency: the share of the prompt served from cache. `undefined`
 * when the provider reports no caching at all, so the UI can stay quiet instead
 * of showing a misleading `0%`.
 */
export function cacheHitRate(usage: TokenUsage | undefined): number | undefined {
  if (!usage) {
    return undefined;
  }
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const prompt = usage.inputTokens + read + write;
  if (prompt <= 0 || (read === 0 && write === 0)) {
    return undefined;
  }
  return (read / prompt) * 100;
}

export function formatCost(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || costUsd <= 0) {
    return undefined;
  }
  return `$${costUsd.toFixed(3)}`;
}

/** Context percentage, or `undefined` when the agent has not answered yet. */
export function contextPercent(context: ContextUsage | undefined): number | undefined {
  if (!context || context.percent === null) {
    return undefined;
  }
  return context.percent;
}

/**
 * The compact footer line, laid out like pi's own: `↑input ↓output Rcache
 * Wwrite CHhit% $cost ctx%/window`. Only the parts the provider actually reports
 * are shown.
 */
export function formatUsage(state: {
  usage?: TokenUsage;
  costUsd?: number;
  contextUsage?: ContextUsage;
}): string {
  const parts: string[] = [];
  const usage = state.usage;
  if (usage) {
    if (usage.inputTokens > 0) {
      parts.push(`↑${formatTokens(usage.inputTokens)}`);
    }
    if (usage.outputTokens > 0) {
      parts.push(`↓${formatTokens(usage.outputTokens)}`);
    }
    if (usage.cacheReadTokens) {
      parts.push(`R${formatTokens(usage.cacheReadTokens)}`);
    }
    if (usage.cacheWriteTokens) {
      parts.push(`W${formatTokens(usage.cacheWriteTokens)}`);
    }
    const hit = cacheHitRate(usage);
    if (hit !== undefined) {
      parts.push(`CH${hit.toFixed(1)}%`);
    }
  }
  const cost = formatCost(state.costUsd);
  if (cost) {
    parts.push(cost);
  }
  const context = state.contextUsage;
  if (context) {
    const percent = context.percent !== null ? `${context.percent.toFixed(1)}%` : '?';
    parts.push(`${percent}/${formatTokens(context.contextWindow)}`);
  }
  return parts.join(' ');
}
