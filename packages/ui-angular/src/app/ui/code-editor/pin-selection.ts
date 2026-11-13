/**
 * Turning a document selection into a pin. The arithmetic is pure, so it is
 * tested without a CodeMirror view: the editor hands it the document and two
 * offsets from `state.selection.main`.
 *
 * The frame is the one the rest of Morse already speaks (`system/context/
 * selection-span.ts`, VS Code's own selections): lines and columns are 1-based,
 * columns count UTF-16 units, the selection's end is exclusive, and a selection
 * that stops at the first column of a later line is normalised to the last
 * character of the line before it — so an end column of 0 never reaches a chip.
 */
import { Text } from '@codemirror/state';

/** What a pin needs before the store gives it an id and a path. */
export interface PinRequest {
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  characters?: number;
  text?: string;
}

/**
 * A pin payload for the document range `[from, to)`, or `null` for an empty
 * selection. `lineOnly` (the gutter drag) reports whole lines and no columns;
 * otherwise columns are exact and a single-line selection carries its words.
 */
export function pinFromText(
  doc: Text,
  from: number,
  to: number,
  options: { lineOnly?: boolean } = {},
): PinRequest | null {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const start = Math.max(0, Math.min(low, doc.length));
  const end = Math.max(0, Math.min(high, doc.length));
  if (start === end) {
    return null;
  }
  const first = doc.lineAt(start);
  let last = doc.lineAt(end);
  if (options.lineOnly) {
    return {
      startLine: first.number,
      ...(last.number !== first.number ? { endLine: last.number } : {}),
      characters: end - start,
    };
  }
  let endColumn = end - last.from;
  if (endColumn === 0 && last.number > first.number) {
    // The caret sits on the first column of a later line: the selection really
    // ends with the previous line's last character.
    last = doc.line(last.number - 1);
    endColumn = last.length;
  }
  const singleLine = last.number === first.number;
  return {
    startLine: first.number,
    ...(singleLine ? {} : { endLine: last.number }),
    startColumn: 1 + (start - first.from),
    endColumn,
    characters: end - start,
    ...(singleLine ? { text: doc.sliceString(start, end).replace(/\r?\n$/, '') } : {}),
  };
}

/** `pinFromText` for a plain string; the string is split into lines once. */
export function pinFromOffsets(
  text: string,
  from: number,
  to: number,
  options: { lineOnly?: boolean } = {},
): PinRequest | null {
  return pinFromText(Text.of(text.split('\n')), from, to, options);
}

/** Where a floating pill sits below a selection rect, kept inside the viewport. */
export function pillAnchoredAt(
  rect: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  pill: { width: number; height: number },
  margin = 6,
): { left: number; top: number } {
  const left = Math.min(rect.left, Math.max(0, viewport.width - pill.width));
  const below = rect.bottom + margin;
  const top = below + pill.height > viewport.height - margin ? rect.top - pill.height - margin : below;
  return { left, top };
}
