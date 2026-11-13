/**
 * Revealing a line, and making it visible when it arrives. The arithmetic is
 * pure so the component can be tested at a state level while the scroll and the
 * flash decoration happen in the view.
 */
import { Decoration } from '@codemirror/view';

/** A 1-based line clamped into a document of `lines` lines; an empty document is line 1. */
export function clampLine(line: number, lines: number): number {
  return Math.min(Math.max(1, Math.round(line)), Math.max(1, lines));
}

/** The line decoration a jump flashes; the animation lives in the stylesheet. */
export const lineFlash = Decoration.line({ class: 'morse-line-flash' });
