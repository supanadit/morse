import { describe, expect, it } from 'vitest';
import { pillAnchoredAt, pinFromOffsets, pinRangeLabel } from './pin-selection';

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

describe('pinRangeLabel', () => {
  it('labels a single line', () => expect(pinRangeLabel({ startLine: 14 })).toBe('L14'));
  it('labels a line range', () => expect(pinRangeLabel({ startLine: 14, endLine: 22 })).toBe('L14-22'));
  it('labels a one-line column range', () =>
    expect(pinRangeLabel({ startLine: 14, startColumn: 3, endColumn: 18 })).toBe('L14:3-18'));
  it('labels a multi-line column range', () =>
    expect(pinRangeLabel({ startLine: 14, endLine: 22, startColumn: 3, endColumn: 9 })).toBe('L14:3-22'));
});

describe('pillAnchoredAt', () => {
  it('sits below the selection end, inside the viewport', () => {
    expect(
      pillAnchoredAt({ left: 10, top: 100, bottom: 120 }, { width: 400, height: 300 }, { width: 140, height: 28 }),
    ).toEqual({ left: 10, top: 126 });
  });
  it('flips left when it would overflow the right edge', () => {
    expect(
      pillAnchoredAt({ left: 380, top: 100, bottom: 120 }, { width: 400, height: 300 }, { width: 140, height: 28 }),
    ).toEqual({ left: 260, top: 126 });
  });
  it('clamps above when the selection is at the bottom', () => {
    expect(
      pillAnchoredAt({ left: 10, top: 280, bottom: 300 }, { width: 400, height: 300 }, { width: 140, height: 28 }).top,
    ).toBeLessThan(280);
  });
});
