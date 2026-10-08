import { describe, expect, it } from 'vitest';
import { highlightCode } from './highlight.js';

describe('highlightCode', () => {
  it('highlights a known language and reports the one it used', () => {
    const result = highlightCode('const a = 1;', 'ts');

    expect(result.language).toBe('typescript');
    expect(result.html).toContain('hljs-keyword');
  });

  it('escapes an unknown language instead of highlighting it', () => {
    const result = highlightCode('<b>&', 'nonesuch');

    expect(result.language).toBe('text');
    expect(result.html).toBe('&lt;b&gt;&amp;');
  });

  it('answers the same block from memory, so a re-render only pays for the tail', () => {
    const first = highlightCode('def f():\n    return 1', 'python');
    const second = highlightCode('def f():\n    return 1', 'python');

    // Identity, not equality: a fresh object would mean it highlighted again,
    // which is the cost this cache exists to remove while an answer streams.
    expect(second).toBe(first);
  });

  it('resolves an alias before remembering, so `ts` and `typescript` share one entry', () => {
    const viaAlias = highlightCode('const a = 1;', 'ts');
    const canonical = highlightCode('const a = 1;', 'typescript');

    expect(viaAlias).toBe(canonical);
  });

  it('never serves one language the block of another', () => {
    const highlighted = highlightCode('const a = 1;', 'ts');
    const escaped = highlightCode('const a = 1;', 'nonesuch');

    expect(escaped.html).not.toBe(highlighted.html);
    expect(escaped.html).toBe('const a = 1;');
  });

  it('stays correct after dropping the oldest blocks', () => {
    const first = highlightCode('const keep = 1;', 'ts');
    // Well past the entry cap, so `keep` has certainly been evicted by now.
    for (let index = 0; index < 300; index += 1) {
      highlightCode(`const filler = ${index};`, 'ts');
    }

    const again = highlightCode('const keep = 1;', 'ts');

    expect(again.html).toBe(first.html);
    expect(again.language).toBe('typescript');
  });

  it('still answers for a block too large to remember', () => {
    // Over the character budget: it is answered, then evicted rather than held.
    const huge = '<'.repeat(600_000);
    const result = highlightCode(huge, 'nonesuch');

    expect(result.language).toBe('text');
    expect(result.html.startsWith('&lt;')).toBe(true);
    expect(result.html.length).toBe(huge.length * 4);
  });
});
