/**
 * Revealing a line, and making it visible when it arrives. The arithmetic is
 * pure so the component can be tested at a state level while the scroll and the
 * flash decoration happen in the view.
 */
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** A 1-based line clamped into a document of `lines` lines; an empty document is line 1. */
export function clampLine(line: number, lines: number): number {
  return Math.min(Math.max(1, Math.round(line)), Math.max(1, lines));
}

/** The line decoration a jump flashes; the animation lives in the stylesheet. */
export const lineFlash = Decoration.line({ class: 'morse-line-flash' });

/** Flash the line that starts at this offset. */
export const flashLine = StateEffect.define<number>();

/** Stop the flash; the component sends this when the animation is over. */
export const clearFlash = StateEffect.define<null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(flashLine)) {
        return Decoration.set([lineFlash.range(effect.value)]);
      }
      if (effect.is(clearFlash)) {
        return Decoration.none;
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Hold the flashed line in the editor's state so a redraw cannot lose it. */
export const flashExtension = flashField;

/** Scroll a 1-based line into the middle of the view and flash it. */
export function revealLine(view: EditorView, line: number): number {
  const number = clampLine(line, view.state.doc.lines);
  const from = view.state.doc.line(number).from;
  view.dispatch({
    effects: [EditorView.scrollIntoView(from, { y: 'center' }), flashLine.of(from)],
  });
  return number;
}
