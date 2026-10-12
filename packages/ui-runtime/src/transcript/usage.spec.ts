import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@morse/protocol';
import { formatRate, formatUsageValue } from './usage.js';

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

describe('formatRate', () => {
  it('keeps a decimal below 100, where a speed is read rather than counted', () => {
    expect(formatRate(42.7)).toBe('42.7/s');
    expect(formatRate(11.25)).toBe('11.3/s');
  });

  it('rounds above 100, where the decimal is noise', () => {
    expect(formatRate(123.4)).toBe('123/s');
    expect(formatRate(100)).toBe('100/s');
  });

  it('shows an em dash while nothing has been timed', () => {
    // A session from before the feature, or one mid-first-message: `0/s` would
    // claim instant generation, and a blank cell would look broken.
    expect(formatRate(undefined)).toBe('—');
    expect(formatRate(Number.NaN)).toBe('—');
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
