/**
 * Where the usage panel goes when its trigger sits inside a pane rather than at
 * the edge of the window.
 *
 * The ring opens into a 320px panel hung to its left, which is right when the
 * ring is at the end of the composer's toolbar. A ring in a bot's live row is
 * inside the scrolling transcript, though: there the panel ran past the pane's
 * left edge — the transcript clips it, right where the sidebar begins — so the
 * panel lost its left border and read as sliding under the sidebar. The same
 * maths answers both: measure the box that can show the panel, put the panel
 * inside it, and open away from the trigger when hanging left would not fit.
 */

/** The panel's own width, before a narrow pane shrinks it. */
export const USAGE_PANEL_WIDTH = 320;
/** Room kept between the panel and the edge of whatever can show it. */
const MARGIN = 8;
/** Room kept between the panel's bottom and the trigger's top. */
const GAP = 8;
/** A panel is never squeezed below this; a tiny pane gets a cramped one, not none. */
const MIN_HEIGHT = 80;

/** A rectangle in viewport pixels. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PanelPlacement {
  /** The panel's left edge, in px from the trigger's own left edge. */
  left: number;
  /** The most it may be wide, so it fits the box that shows it. */
  width: number;
  /** The most it may be tall, so its header stays in the room above the trigger. */
  height: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * The panel's placement for one trigger, inside the box that can show it.
 *
 * Centred over the trigger is the first choice, and is what a ring in the middle
 * of a live row wants: the panel lands well inside the pane, so it cannot read as
 * clipped by whatever borders it. When there is no room to centre — a composer's
 * ring sits at the end of its toolbar — the panel hangs to the left of the
 * trigger, its right edge on the ring's, as it always has. Either way the result
 * is clamped, so no pane can push the panel past what it can draw.
 */
export function placeUsagePanel(anchor: Box, clip: Box): PanelPlacement {
  const width = Math.min(USAGE_PANEL_WIDTH, Math.max(0, clip.right - clip.left - 2 * MARGIN));
  const low = clip.left + MARGIN;
  const high = clip.right - MARGIN - width;
  const centred = anchor.left + (anchor.right - anchor.left - width) / 2;
  const hangingLeft = anchor.right - width;
  const screenLeft = clamp(
    [centred, hangingLeft, anchor.left].find((left) => left >= low && left <= high) ?? anchor.left,
    low,
    high,
  );
  const above = anchor.top - clip.top - GAP - MARGIN;
  const room = clip.bottom - clip.top - 2 * MARGIN;
  return {
    left: Math.round(screenLeft - anchor.left),
    width: Math.round(width),
    // Never taller than the room above the trigger, and never more than most of
    // the pane: the panel scrolls inside itself rather than growing past the edge.
    height: Math.round(Math.max(MIN_HEIGHT, Math.min(above, room * 0.7))),
  };
}
