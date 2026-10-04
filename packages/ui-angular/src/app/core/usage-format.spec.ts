import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@morse/protocol';
import { formatUsageValue } from './usage-format';

describe('formatUsageValue', () => {
  const usage: TokenUsage = {
    inputTokens: 780,
    outputTokens: 280,
    totalTokens: 1_060,
  };

  it('renders a reported count, formatted', () => {
    expect(formatUsageValue(usage, 'inputTokens')).toBe('780');
    expect(formatUsageValue({ ...usage, cacheReadTokens: 51_000 }, 'cacheReadTokens')).toBe('51k');
  });

  it('honours an explicit zero the provider did report', () => {
    expect(formatUsageValue({ ...usage, cacheWriteTokens: 0 }, 'cacheWriteTokens')).toBe('0');
  });

  it('shows an em dash for a field the provider never reported', () => {
    // pi coerces a missing reasoning breakdown to 0, so `reasoningTokens` is
    // absent when nobody counted it — `0` would claim the model did not think.
    expect(formatUsageValue(usage, 'reasoningTokens')).toBe('—');
    expect(formatUsageValue(usage, 'cacheWriteTokens')).toBe('—');
  });

  it('shows an em dash when there is no usage at all', () => {
    expect(formatUsageValue(undefined, 'reasoningTokens')).toBe('—');
  });
});
