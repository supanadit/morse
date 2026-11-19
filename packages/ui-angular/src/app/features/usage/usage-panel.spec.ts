import { describe, expect, it } from 'vitest';
import { USAGE_PANEL_WIDTH, placeUsagePanel, type Box } from './usage-panel';

/**
 * The usage panel hangs off a small ring, and the ring can sit anywhere: at the
 * end of the composer's toolbar, or in the middle of a bot's live row inside the
 * scrolling transcript. The pane — not the window — is what can show it, so the
 * panel has to be placed against the pane or it is clipped exactly at the edge
 * that borders the sidebar.
 */

/** A trigger of the given width, with its left edge where the test says. */
function ring(left: number, width = 52): Box {
  return { left, right: left + width, top: 500, bottom: 520 };
}

describe('usage panel placement', () => {
  it('hangs left of a ring at the end of a toolbar, like the ring always did', () => {
    // A composer near the right of a 1200px window.
    const pane: Box = { left: 0, right: 1200, top: 0, bottom: 800 };
    const placed = placeUsagePanel(ring(1100), pane);

    expect(placed.width).toBe(USAGE_PANEL_WIDTH);
    // Its right edge is the ring's right edge: 1152 - 320.
    expect(placed.left).toBe(1152 - USAGE_PANEL_WIDTH - 1100);
  });

  it('centres over a ring mid-row, so the panel lands well inside the pane', () => {
    // A live row's ring mid-transcript: the transcript starts at 372. Hung left,
    // the panel's edge would land at 370 — on the pane's very edge, which is what
    // read as sliding under the sidebar.
    const pane: Box = { left: 372, right: 1180, top: 0, bottom: 740 };
    const placed = placeUsagePanel(ring(638), pane);

    const left = 638 + placed.left;
    expect(left).toBe(504);
    expect(left).toBeGreaterThanOrEqual(pane.left + 8);
    expect(left + placed.width).toBeLessThanOrEqual(pane.right - 8);
  });

  it('shrinks to the pane when the pane is narrower than the panel', () => {
    const pane: Box = { left: 300, right: 540, top: 0, bottom: 700 };
    const placed = placeUsagePanel(ring(420), pane);

    expect(placed.width).toBe(240 - 16);
    // And it starts at the pane's margin, not before it.
    expect(420 + placed.left).toBeGreaterThanOrEqual(pane.left + 8);
    expect(420 + placed.left + placed.width).toBeLessThanOrEqual(pane.right - 8);
  });

  it('never grows taller than the room above the ring', () => {
    const pane: Box = { left: 0, right: 1200, top: 100, bottom: 800 };
    const placed = placeUsagePanel({ ...ring(900), top: 260, bottom: 280 }, pane);

    // The pane starts at 100, and the ring's top is 260: 160 minus the 8px gap
    // and the 8px margin.
    expect(placed.height).toBe(144);
  });

  it('never asks for less than a readable panel', () => {
    const pane: Box = { left: 0, right: 1200, top: 0, bottom: 800 };
    const placed = placeUsagePanel({ ...ring(900), top: 20, bottom: 40 }, pane);

    expect(placed.height).toBe(80);
  });
});
