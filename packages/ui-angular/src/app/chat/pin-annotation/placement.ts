/**
 * Where an anchored popover goes, as pure arithmetic so the rule is testable
 * without a layout engine.
 *
 * The annotation editor is anchored to whatever ✎ opened it — a chip in the
 * composer, a band's corner in the file preview, a diff row — so it cannot use
 * an `offsetParent` trick like the composer's pickers: those always open above
 * one box, this one opens next to any element. It is therefore placed *fixed*
 * from the anchor's viewport rect, and this is the part that decides whether
 * that lands below or above, and how it clamps into the window.
 */

export interface PopoverAnchor {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

export interface PopoverSpot {
  top: number;
  left: number;
  /** The side the card ended up on, for an arrow or an entry animation. */
  placement: 'above' | 'below';
}

/**
 * The spot, in viewport coordinates. Preference is below the anchor (the way a
 * comment box follows a highlight); it flips above when the bottom has no room
 * and the top has more, and clamps on both axes so a card near an edge slides
 * into view instead of being cut off.
 */
export function placePopover(
  anchor: PopoverAnchor,
  size: PopoverSize,
  viewport: PopoverViewport,
  gap = 8,
  margin = 8,
): PopoverSpot {
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - size.height;
  const roomBelow = below + size.height + margin <= viewport.height;
  const placement: PopoverSpot['placement'] =
    roomBelow || above < margin ? 'below' : 'above';
  const wanted = placement === 'below' ? below : above;
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  return {
    placement,
    top: Math.min(Math.max(wanted, margin), maxTop),
    left: Math.min(Math.max(anchor.left + anchor.width / 2 - size.width / 2, margin), maxLeft),
  };
}
