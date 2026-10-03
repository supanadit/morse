import { describe, expect, it } from 'vitest';
import { cacheHitRate, formatTokens, formatUsage } from '../../core/usage-format';
import { outputChars, builtinName, compactInstructions } from './chat-composer';

describe('formatTokens', () => {
  it('compacts like pi: 1.2k, 56k, 2.8M', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_200)).toBe('1.2k');
    expect(formatTokens(56_400)).toBe('56k');
    expect(formatTokens(2_800_000)).toBe('2.8M');
    expect(formatTokens(12_000_000)).toBe('12M');
  });
});

describe('formatUsage', () => {
  it('renders the TUI footer layout with cache hit and context', () => {
    const label = formatUsage({
      usage: {
        inputTokens: 56_400,
        outputTokens: 35_200,
        totalTokens: 91_600,
        cacheReadTokens: 2_800_000,
        cacheWriteTokens: 12_000,
      },
      costUsd: 0.42,
      contextUsage: { tokens: 79_000, contextWindow: 1_000_000, percent: 7.9 },
    });

    // cache hit = 2.8M / (56.4k + 2.8M + 12k) ~ 97.6%
    expect(label).toBe('↑56k ↓35k R2.8M W12k CH97.6% $0.420 7.9%/1.0M');
  });

  it('omits a cache hit when the provider reports no caching', () => {
    const label = formatUsage({
      usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    });

    expect(label).toBe('↑500 ↓200 ?/200k');
  });

  it('is empty before any usage arrives', () => {
    expect(formatUsage({})).toBe('');
  });
});

describe('cacheHitRate', () => {
  it('is undefined when the provider reports no caching', () => {
    expect(cacheHitRate({ inputTokens: 500, outputTokens: 1, totalTokens: 501 })).toBeUndefined();
  });

  it('is the share of the prompt served from cache', () => {
    expect(
      cacheHitRate({
        inputTokens: 1000,
        outputTokens: 10,
        totalTokens: 1010,
        cacheReadTokens: 3000,
      }),
    ).toBe(75);
  });
});

describe('outputChars', () => {
  it('counts thinking, not just the visible answer', () => {
    const items = [
      { kind: 'assistant', text: 'hello', thinking: '1234567890' },
      { kind: 'tool', text: 'ignored' },
      { kind: 'user', text: 'ignored' },
    ];
    // 5 + 10 = 15; tool output and the user prompt are not generated tokens.
    expect(outputChars(items)).toBe(15);
  });

  it('is monotonic across assistant messages in one run', () => {
    const first = [{ kind: 'assistant', text: 'aaaa', thinking: '' }];
    const second = [
      { kind: 'assistant', text: 'aaaa', thinking: '' },
      { kind: 'assistant', text: 'bb', thinking: 'ccc' },
    ];
    expect(outputChars(second)).toBeGreaterThan(outputChars(first));
  });
});

/** Only TUI built-ins are Morse's to run; everything else goes to pi. */
describe('builtinName', () => {
  it('recognises a bare built-in', () => {
    expect(builtinName('/compact')).toBe('compact');
    expect(builtinName('/model')).toBe('model');
    expect(builtinName('/about')).toBe('about');
  });

  it('leaves pi commands to pi', () => {
    expect(builtinName('/skill:codebase-memory')).toBeUndefined();
    expect(builtinName('/fix-tests')).toBeUndefined();
    expect(builtinName('/unknown')).toBeUndefined();
  });

  it('is not a command when there are arguments', () => {
    expect(builtinName('/compact keep the decisions')).toBeUndefined();
  });
});

/**
 * `/compact …` with arguments is not a *built-in*, but it is the same compaction —
 * so the composer gates it too, with the words attached.
 */
describe('compactInstructions', () => {
  it('takes the words that followed the command', () => {
    expect(compactInstructions('/compact keep the decisions')).toBe('keep the decisions');
    expect(compactInstructions('/compact  keep   the schema ')).toBe('keep   the schema');
    expect(compactInstructions('/compact\nkeep the decisions')).toBe('keep the decisions');
  });

  it('leaves the bare command and everything else alone', () => {
    expect(compactInstructions('/compact')).toBeUndefined();
    expect(compactInstructions('/compactable')).toBeUndefined();
    expect(compactInstructions('/fix-tests compact it')).toBeUndefined();
    expect(compactInstructions('please /compact this')).toBeUndefined();
  });
});
