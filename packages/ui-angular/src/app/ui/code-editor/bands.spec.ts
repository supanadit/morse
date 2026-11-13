import { describe, expect, it } from 'vitest';
import { pinAtLine } from './bands';
import type { EditorPin } from './pins';

const pins: EditorPin[] = [
  { id: 'a', startLine: 4, endLine: 7 },
  { id: 'b', startLine: 12 },
  { id: 'c', startLine: 20, endLine: 22 },
];

describe('pinAtLine', () => {
  it('finds the pin whose band covers the line', () => {
    expect(pinAtLine(pins, 4)?.id).toBe('a');
    expect(pinAtLine(pins, 6)?.id).toBe('a');
    expect(pinAtLine(pins, 7)?.id).toBe('a');
  });

  it('treats a one-line pin as one line, not a range', () => {
    expect(pinAtLine(pins, 12)?.id).toBe('b');
    expect(pinAtLine(pins, 13)).toBeUndefined();
  });

  it('has no pin for a line between bands, or for no line at all', () => {
    expect(pinAtLine(pins, 8)).toBeUndefined();
    expect(pinAtLine(pins, 19)).toBeUndefined();
    expect(pinAtLine(pins, undefined)).toBeUndefined();
    expect(pinAtLine([], 4)).toBeUndefined();
  });
});
