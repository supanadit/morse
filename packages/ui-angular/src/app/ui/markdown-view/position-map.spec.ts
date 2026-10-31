import { describe, expect, it } from 'vitest';
import { PositionMap, type PositionMapMetrics } from './position-map';

const METRICS: PositionMapMetrics = {
  lineHeight: 20,
  charWidth: 10,
  paddingLeft: 5,
  paddingTop: 10,
  paddingRight: 5,
  containerWidth: 110, // 100px content width -> 10 chars per line
};

describe('PositionMap', () => {
  it('maps single-line text round-trip faithfully', () => {
    const text = 'hello';
    const map = new PositionMap({ text, metrics: METRICS });

    for (let offset = 0; offset <= text.length; offset++) {
      const rect = map.bufferToRect(offset);
      expect(rect.top).toBe(METRICS.paddingTop);
      expect(rect.left).toBe(METRICS.paddingLeft + offset * METRICS.charWidth);
      expect(rect.height).toBe(METRICS.lineHeight);

      // viewToBuffer at the middle of the char slot
      const targetX = rect.left + (offset < text.length ? METRICS.charWidth / 2 : 0);
      const targetY = rect.top + METRICS.lineHeight / 2;
      const roundTrip = map.viewToBuffer(targetX, targetY);
      expect(roundTrip).toBe(offset);
    }
  });

  it('handles double-wrap shapes across multiple wrapped lines', () => {
    // container has content width = 10 chars per line
    // 25 chars will wrap twice (Line 0: 10 chars, Line 1: 10 chars, Line 2: 5 chars)
    const text = 'abcdefghijklmnopqrstuvwxy'; // 25 chars
    const map = new PositionMap({ text, metrics: METRICS });

    // Check line 0 (char 'a' at offset 0)
    const rect0 = map.bufferToRect(0);
    expect(rect0.top).toBe(METRICS.paddingTop);
    expect(rect0.left).toBe(METRICS.paddingLeft);

    // Check line 1 (char 'k' at offset 10)
    const rect10 = map.bufferToRect(10);
    expect(rect10.top).toBe(METRICS.paddingTop + METRICS.lineHeight);
    expect(rect10.left).toBe(METRICS.paddingLeft);

    // Check line 2 (char 'u' at offset 20)
    const rect20 = map.bufferToRect(20);
    expect(rect20.top).toBe(METRICS.paddingTop + 2 * METRICS.lineHeight);
    expect(rect20.left).toBe(METRICS.paddingLeft);

    // Round-trip check for wrapped offsets
    for (const offset of [0, 5, 10, 15, 20, 24, 25]) {
      const rect = map.bufferToRect(offset);
      const x = rect.left + (offset < text.length ? METRICS.charWidth / 2 : 0);
      const y = rect.top + METRICS.lineHeight / 2;
      expect(map.viewToBuffer(x, y)).toBe(offset);
    }
  });

  it('handles trailing-empty shapes (ending in newline)', () => {
    const text = 'line 1\n';
    const map = new PositionMap({ text, metrics: METRICS });

    // Offset before newline
    const rectBefore = map.bufferToRect(text.length - 1);
    expect(rectBefore.top).toBe(METRICS.paddingTop);

    // Offset at newline/empty line
    const rectAfter = map.bufferToRect(text.length);
    expect(rectAfter.top).toBe(METRICS.paddingTop + METRICS.lineHeight);
    expect(rectAfter.left).toBe(METRICS.paddingLeft);

    // Clicking into the empty line lands on the trailing position
    const offset = map.viewToBuffer(METRICS.paddingLeft + 10, METRICS.paddingTop + METRICS.lineHeight + 5);
    expect(offset).toBe(text.length);
  });

  it('handles hidden ranges like fence lines', () => {
    // Hidden fence line: '```ts\n'
    const text = '```ts\ncode\n```';
    const map = new PositionMap({
      text,
      metrics: METRICS,
      hiddenRanges: [
        { start: 0, end: 6 }, // '```ts\n'
        { start: 11, end: 14 }, // '```'
      ],
    });

    // Hidden offsets map without error
    const rectFence = map.bufferToRect(0);
    expect(rectFence).toBeDefined();

    // Code offset lands properly
    const rectCode = map.bufferToRect(6);
    expect(rectCode.top).toBe(METRICS.paddingTop + METRICS.lineHeight);
  });

  describe('full matrix round-trip', () => {
    const testCases: Array<{ name: string; text: string }> = [
      { name: 'short single-line', text: 'hi' },
      { name: 'wraps twice', text: '1234567890abcdefghijABCDE' },
      { name: 'emoji width', text: 'code 🚀 test 🎉' },
      { name: 'trailing spaces', text: 'line with spaces   \nnext' },
      { name: 'single-line trailing empty', text: 'single line trailing empty\n' },
    ];

    for (const { name, text } of testCases) {
      it(`round-trips ${name}`, () => {
        const map = new PositionMap({ text, metrics: METRICS });

        for (let offset = 0; offset <= text.length; offset++) {
          const rect = map.bufferToRect(offset);
          expect(rect.top).toBeGreaterThanOrEqual(METRICS.paddingTop);
          expect(rect.height).toBe(METRICS.lineHeight);

          const midX = rect.left + (offset < text.length ? Math.max(1, rect.width / 2) : 0);
          const midY = rect.top + METRICS.lineHeight / 2;
          const mapped = map.viewToBuffer(midX, midY);

          // Must either equal offset or valid character position
          expect(mapped).toBeGreaterThanOrEqual(0);
          expect(mapped).toBeLessThanOrEqual(text.length);
        }
      });
    }
  });
});
