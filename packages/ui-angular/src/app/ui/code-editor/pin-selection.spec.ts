import { describe, expect, it } from 'vitest';
import { pillAnchoredAt, pinFromOffsets } from './pin-selection';

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
  it('ends on the last selected character, not one past it', () => {
    expect(pinFromOffsets('abcdef', 2, 5)).toMatchObject({
      startColumn: 3,
      endColumn: 5,
      characters: 3,
      text: 'cde',
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
      endColumn: 2,
      characters: 4,
    });
  });
  it('counts UTF-16 units for a selection over an emoji (Review Focus 5)', () => {
    expect(pinFromOffsets('a😀b', 1, 3)).toMatchObject({
      startColumn: 2,
      endColumn: 3,
      characters: 2,
    });
  });
  it('counts UTF-16 units for a selection after an emoji (Review Focus 5)', () => {
    expect(pinFromOffsets('a😀b', 3, 4)).toEqual({
      startLine: 1,
      startColumn: 4,
      endColumn: 4,
      characters: 1,
      text: 'b',
    });
  });
  it('normalises a selection that stops at a later line’s first column', () => {
    expect(pinFromOffsets('ab\ncd\n', 0, 6)).toEqual({
      startLine: 1,
      endLine: 2,
      startColumn: 1,
      endColumn: 2,
      characters: 6,
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
