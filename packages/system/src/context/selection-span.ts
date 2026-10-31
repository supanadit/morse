import { MAX_PIN_EXCERPT } from '@morse/agent';

/**
 * One editor position, 0-based and end-exclusive, exactly as an editor reports
 * it. Keeping this shape neutral is what lets the span math be tested without a
 * VS Code test host; the extension adapts its own selection type to it.
 */
export interface SpanPosition {
  line: number;
  character: number;
}

export interface SpanSelection {
  isEmpty: boolean;
  start: SpanPosition;
  end: SpanPosition;
}

/** The 1-based span a pin, a chip and a mention share. */
export interface SelectionSpan {
  startLine: number;
  endLine: number;
  /** 1-based column of the first selected character; absent for a line envelope. */
  startColumn?: number;
  /** 1-based column of the last selected character; absent for a line envelope. */
  endColumn?: number;
  /** Selected UTF-16 characters, line breaks included; absent for a line envelope. */
  characters?: number;
  /** The selected words for a one-line selection, capped; absent across lines. */
  text?: string;
}

/**
 * Turns an editor's selections into the span Morse reports.
 *
 * One non-empty selection keeps its columns and character count. Several
 * non-empty selections collapse to the line envelope they cover and report no
 * columns, because one column pair cannot describe disjoint ranges. Nothing
 * selected returns `undefined` — the caller shows the whole-file preview.
 *
 * An editor selection's end is exclusive, so the start column is
 * `start.character + 1` and the end column is `end.character`. A selection that
 * stops at the first column of a later line is normalised to the last character
 * of the line before it, so an end column of 0 never reaches a chip.
 */
export function selectionSpan(
  selections: readonly SpanSelection[],
  textOf: (selection: SpanSelection) => string,
  lineLength: (line: number) => number,
  maxExcerpt: number = MAX_PIN_EXCERPT,
): SelectionSpan | undefined {
  const nonEmpty = selections.filter((selection) => !selection.isEmpty);
  if (nonEmpty.length === 0) {
    return undefined;
  }

  if (nonEmpty.length > 1) {
    let startLine = nonEmpty[0]!.start.line;
    let endLine = nonEmpty[0]!.end.line;
    for (const selection of nonEmpty) {
      startLine = Math.min(startLine, selection.start.line);
      endLine = Math.max(endLine, selection.end.line);
    }
    return { startLine: startLine + 1, endLine: endLine + 1 };
  }

  const selection = nonEmpty[0]!;
  const startLine = selection.start.line;
  let endLine = selection.end.line;
  let endColumn = selection.end.character;
  if (endColumn === 0 && endLine > startLine) {
    endLine -= 1;
    endColumn = lineLength(endLine);
  }

  const text = textOf(selection);
  const span: SelectionSpan = {
    startLine: startLine + 1,
    endLine: endLine + 1,
    startColumn: selection.start.character + 1,
    endColumn,
    characters: text.length,
  };
  if (startLine === endLine) {
    // A selection that included the newline still reads as words on one line.
    const excerpt = text.replace(/\r?\n$/, '').slice(0, maxExcerpt);
    if (excerpt.length > 0) {
      span.text = excerpt;
    }
  }
  return span;
}
