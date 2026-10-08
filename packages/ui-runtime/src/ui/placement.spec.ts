import { describe, expect, it } from 'vitest';
import { placePopover } from './placement.js';

const VIEWPORT = { width: 1_000, height: 800 };
const SIZE = { width: 400, height: 300 };

describe('placePopover', () => {
  it('opens below the anchor when the bottom has room', () => {
    const spot = placePopover(
      { top: 100, left: 300, width: 100, height: 20 },
      SIZE,
      VIEWPORT,
    );
    expect(spot.placement).toBe('below');
    expect(spot.top).toBe(128);
    // Centred on the anchor: 300 + 50 - 200.
    expect(spot.left).toBe(150);
  });

  it('flips above when the bottom has no room and the top has more', () => {
    const spot = placePopover(
      { top: 700, left: 300, width: 100, height: 20 },
      SIZE,
      VIEWPORT,
    );
    expect(spot.placement).toBe('above');
    expect(spot.top).toBe(392);
  });

  it('stays below when neither side fits, and is never cut off the bottom', () => {
    const spot = placePopover(
      { top: 300, left: 0, width: 20, height: 600 },
      SIZE,
      VIEWPORT,
    );
    expect(spot.placement).toBe('below');
    expect(spot.top).toBeGreaterThanOrEqual(8);
    expect(spot.top + SIZE.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('slides into view at the left and right edges', () => {
    const left = placePopover({ top: 10, left: 0, width: 10, height: 10 }, SIZE, VIEWPORT);
    expect(left.left).toBe(8);
    const right = placePopover({ top: 10, left: 990, width: 10, height: 10 }, SIZE, VIEWPORT);
    expect(right.left + SIZE.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(right.left).toBe(592);
  });

  it('never places the card above the top margin, however tall it is', () => {
    const spot = placePopover(
      { top: 20, left: 100, width: 10, height: 10 },
      { width: 400, height: 790 },
      VIEWPORT,
    );
    expect(spot.top).toBe(8);
  });
});
