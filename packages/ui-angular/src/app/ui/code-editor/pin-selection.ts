/**
 * Turning a document selection into a pin. Pure string arithmetic, so it is
 * tested without a CodeMirror view: the editor hands it offsets from
 * `state.selection.main` and gets the payload `AttachmentStore.pin` takes.
 *
 * Lines and columns are 1-based, the frame the chip labels and `PendingPin`
 * use. Columns count Unicode code points; `characters` counts UTF-16 units,
 * which is what `String.length` and the wire both use.
 */

/** What a pin needs before the store gives it an id and a path. */
export interface PinRequest {
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  characters?: number;
  text?: string;
}

/** The covered text in code points: what a column counts. */
function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/** The 1-based line and its start offset for a document offset. */
function lineAt(starts: readonly number[], offset: number): { line: number; start: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low + 1, start: starts[low]! };
}

/** Line start offsets of a document, `starts[0]` always 0. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * A pin payload for `[from, to)`, or `null` for an empty selection. `lineOnly`
 * (the gutter drag) reports whole lines and no columns; otherwise columns are
 * exact and a single-line selection carries the words it covers.
 */
export function pinFromOffsets(
  text: string,
  from: number,
  to: number,
  options: { lineOnly?: boolean } = {},
): PinRequest | null {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const start = Math.max(0, Math.min(low, text.length));
  const end = Math.max(0, Math.min(high, text.length));
  if (start === end) {
    return null;
  }
  const starts = lineStarts(text);
  const first = lineAt(starts, start);
  const last = lineAt(starts, end);
  if (options.lineOnly) {
    return {
      startLine: first.line,
      ...(last.line !== first.line ? { endLine: last.line } : {}),
      characters: end - start,
    };
  }
  // End of line is a caret past the last character, which no column names: cap
  // it at the line's own length so `L14:3` never reads as column 4 of a 3-char line.
  const lastLineEnd = last.line < starts.length ? starts[last.line]! - 1 : text.length;
  const lastLineLength = codePoints(text.slice(last.start, lastLineEnd));
  const startColumn = 1 + codePoints(text.slice(first.start, start));
  const endColumn = Math.min(1 + codePoints(text.slice(last.start, end)), lastLineLength);
  const singleLine = last.line === first.line;
  return {
    startLine: first.line,
    ...(singleLine ? {} : { endLine: last.line }),
    startColumn,
    endColumn,
    characters: end - start,
    ...(singleLine ? { text: text.slice(start, end) } : {}),
  };
}
