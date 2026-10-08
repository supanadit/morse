import { describe, expect, it } from 'vitest';
import { popoverMaxHeight } from './popover-fit.directive';

describe('popoverMaxHeight', () => {
  it('uses the preferred height while the viewport has room', () => {
    // 800px of room, a 340px wish: the popover keeps its natural size.
    expect(popoverMaxHeight(800, 340)).toBe(340);
  });

  it('shrinks to the room above the anchor instead of clipping', () => {
    // 200px above the composer: 200 - 12px of gap = 188px.
    expect(popoverMaxHeight(200, 340)).toBe(188);
  });

  it('never collapses below the usable minimum', () => {
    // A tiny panel still shows a couple of rows rather than a zero-height popover.
    expect(popoverMaxHeight(40, 340)).toBe(80);
  });
});
