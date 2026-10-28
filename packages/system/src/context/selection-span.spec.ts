import { describe, expect, it } from 'vitest';
import { selectionSpan, type SpanSelection } from './selection-span.js';

function at(line: number, character: number): SpanSelection {
  return {
    isEmpty: false,
    start: { line, character },
    end: { line, character },
  };
}

describe('selectionSpan', () => {
  it('reports the columns and count of a phrase on one line', () => {
    const selection: SpanSelection = {
      isEmpty: false,
      start: { line: 17, character: 44 },
      end: { line: 17, character: 79 },
    };
    const text = 'the highlighted words of one line';

    const span = selectionSpan([selection], () => text, () => 100);

    expect(span).toEqual({
      startLine: 18,
      endLine: 18,
      startColumn: 45,
      endColumn: 79,
      characters: text.length,
      text,
    });
  });

  it('keeps both columns for a partial range across lines and carries no excerpt', () => {
    const selection: SpanSelection = {
      isEmpty: false,
      start: { line: 17, character: 44 },
      end: { line: 19, character: 12 },
    };
    const text = 'the words\n\nand the end';

    const span = selectionSpan([selection], () => text, () => 100);

    expect(span).toEqual({
      startLine: 18,
      endLine: 20,
      startColumn: 45,
      endColumn: 12,
      characters: text.length,
    });
  });

  it('normalises a selection that ends at the first column of a later line', () => {
    const selection: SpanSelection = {
      isEmpty: false,
      start: { line: 18, character: 0 },
      end: { line: 19, character: 0 },
    };

    const span = selectionSpan([selection], () => 'abc\n', (line) => (line === 18 ? 3 : 0));

    expect(span).toEqual({
      startLine: 19,
      endLine: 19,
      startColumn: 1,
      endColumn: 3,
      characters: 4,
      text: 'abc',
    });
  });

  it('has no span when nothing is selected', () => {
    const empty: SpanSelection = {
      isEmpty: true,
      start: { line: 3, character: 0 },
      end: { line: 3, character: 0 },
    };

    expect(selectionSpan([empty], () => '', () => 10)).toBeUndefined();
    expect(selectionSpan([], () => '', () => 10)).toBeUndefined();
  });

  it('collapses several carets to their line envelope without columns', () => {
    const first = at(4, 2);
    const second = at(7, 9);

    const span = selectionSpan(
      [first, { ...second, end: { line: 9, character: 4 } }],
      () => 'unused',
      () => 80,
    );

    expect(span).toEqual({ startLine: 5, endLine: 10 });
  });

  it('caps a long one-line excerpt while keeping the full range', () => {
    const selection: SpanSelection = {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 200 },
    };

    const span = selectionSpan([selection], () => 'x'.repeat(200), () => 200, 120);

    expect(span?.text).toHaveLength(120);
    expect(span?.endColumn).toBe(200);
  });
});
