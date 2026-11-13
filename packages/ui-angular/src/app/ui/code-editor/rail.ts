/**
 * Where each note card sits in the rail. Placement is pure arithmetic so the
 * view only has to measure line tops and paint: a card starts at its line's
 * top, and every card that would overlap the one above it is pushed down.
 */

/** One card's vertical placement in the rail. */
export interface RailSlot {
  readonly top: number;
  readonly height: number;
}

/**
 * Non-overlapping slots in the order given (line order, not sorted here).
 * An anchor of `null` means the line could not be measured — folded, or scrolled
 * out of a virtualised region — and yields no card, without moving the cursor.
 */
export function railSlots(
  anchors: readonly (number | null)[],
  heights: readonly number[],
  gap = 6,
): (RailSlot | null)[] {
  const slots: (RailSlot | null)[] = [];
  let bottom = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (anchor === null || anchor === undefined) {
      slots.push(null);
      continue;
    }
    const height = heights[i] ?? 0;
    const top = Math.max(anchor, bottom + gap);
    slots.push({ top, height });
    bottom = top + height;
  }
  return slots;
}
