import { describe, expect, it } from 'vitest';
import { clampLine } from './scroll';

describe('clampLine', () => {
  it('keeps a line in range', () => expect(clampLine(3, 10)).toBe(3));
  it('clamps above', () => expect(clampLine(0, 10)).toBe(1));
  it('clamps below', () => expect(clampLine(99, 10)).toBe(10));
  it('survives an empty document', () => expect(clampLine(5, 0)).toBe(1));
});
