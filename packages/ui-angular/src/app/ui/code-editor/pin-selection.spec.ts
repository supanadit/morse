import { describe, expect, it } from 'vitest';
import { pinFromOffsets } from './pin-selection';

const doc = 'one\ntwo\nthree';

describe('pinFromOffsets', () => {
  it('returns null for an empty selection', () => {
    expect(pinFromOffsets(doc, 2, 2)).toBeNull();
  });
  it('pins a single line with columns and text', () => {
    expect(pinFromOffsets(doc, 0, 3)).toEqual({
      startLine: 1,
      startColumn: 1,
      endColumn: 3,
      characters: 3,
      text: 'one',
    });
  });
  it('pins whole lines from a gutter drag', () => {
    expect(pinFromOffsets(doc, 0, 7, { lineOnly: true })).toEqual({
      startLine: 1,
      endLine: 2,
      characters: 7,
    });
  });
  it('pins a multi-line selection without text', () => {
    expect(pinFromOffsets(doc, 2, 6)).toEqual({
      startLine: 1,
      endLine: 2,
      startColumn: 3,
      endColumn: 3,
      characters: 4,
    });
  });
  it('counts UTF-16 units for emoji (Review Focus 5)', () => {
    expect(pinFromOffsets('a😀b', 1, 3)).toMatchObject({
      startColumn: 2,
      endColumn: 3,
      characters: 2,
    });
  });
  it('clamps offsets past the end', () => {
    const clamped = pinFromOffsets('ab', 0, 99);
    expect(clamped).toMatchObject({ startLine: 1, startColumn: 1, endColumn: 2, characters: 2 });
    expect(clamped).not.toHaveProperty('endLine');
  });
  it('pins the last line when the doc ends with a newline', () => {
    expect(pinFromOffsets('ab\n', 3, 3)).toBeNull();
  });
});
