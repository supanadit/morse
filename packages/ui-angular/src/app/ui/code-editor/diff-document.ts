/**
 * A diff as a CodeMirror document.
 *
 * The editor is the only code surface: a file and a diff are two documents in the
 * same camera, not two cameras. This module is the pure half of that — it turns a
 * parsed diff into the plain text CodeMirror renders plus the per-line facts the
 * gutters, the tints and the pin bands need, so none of that arithmetic lives in a
 * component or a stylesheet.
 *
 * What a diff costs the reader, and what this keeps:
 *
 * - a hunk header is not a line of any file, so it is a widget above the line it
 *   introduces, never a document line (no gutter number, no pin, no search hit);
 * - a deleted line exists only in the old file, so its row carries `oldLine` and the
 *   new-file line it left behind (`newAnchor`), which is what a pin points at;
 * - the two sides of a split are two documents of the same length, blank-filled
 *   where one side has no line, so the pairing holds line for line.
 */
import { splitRows, unifiedRows, type DiffRow, type ParsedDiff } from '@morse/ui-runtime';
import type { EditorPin } from './pins';

/** A document line's role in the diff. `blank` pads a split side. */
export type DiffLineKind = 'context' | 'add' | 'del' | 'blank';

/** One document line: the text CodeMirror draws, and where it sits in the diff. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number in the old file (absent for an addition). */
  readonly oldLine?: number;
  /** Line number in the new file (absent for a deletion). */
  readonly newLine?: number;
  /** Where this row sits in the new file; a pin's range is in this space. */
  readonly newAnchor?: number;
  /** The new-file range of the change block this row belongs to. */
  readonly change?: { readonly start: number; readonly end: number };
}

/** A hunk header, drawn above the document line at `line` (0-based). */
export interface DiffHunkLabel {
  readonly line: number;
  readonly text: string;
}

/** One side of a diff as CodeMirror sees it: its text, and what each line is. */
export interface DiffDocument {
  readonly lines: readonly DiffLine[];
  readonly hunks: readonly DiffHunkLabel[];
}

/** The document a preview shows before its diff arrives. */
export const EMPTY_DIFF: DiffDocument = { lines: [], hunks: [] };

const BLANK: DiffLine = { kind: 'blank', text: '' };

/** One parsed row as a document line; an absent row pads the side with a blank. */
function toLine(row: DiffRow | undefined): DiffLine {
  if (row === undefined) {
    return BLANK;
  }
  return {
    kind: row.kind,
    text: row.text,
    ...(row.oldLine !== undefined ? { oldLine: row.oldLine } : {}),
    ...(row.newLine !== undefined ? { newLine: row.newLine } : {}),
    ...(row.newAnchor !== undefined ? { newAnchor: row.newAnchor } : {}),
    ...(row.change !== undefined ? { change: row.change } : {}),
  };
}

/** The unified document: every row of every hunk, top to bottom. */
export function unifiedDocument(parsed: ParsedDiff): DiffDocument {
  const lines: DiffLine[] = [];
  const hunks: DiffHunkLabel[] = [];
  for (const row of unifiedRows(parsed)) {
    if (row.kind === 'hunk') {
      hunks.push({ line: lines.length, text: row.text });
      continue;
    }
    lines.push(toLine(row));
  }
  return { lines, hunks };
}

/** The two documents of the side-by-side view, paired row by row. */
export function splitDocuments(parsed: ParsedDiff): {
  left: DiffDocument;
  right: DiffDocument;
} {
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  const hunks: DiffHunkLabel[] = [];
  for (const row of splitRows(parsed)) {
    if (row.hunk !== undefined) {
      hunks.push({ line: left.length, text: row.hunk });
      continue;
    }
    left.push(toLine(row.left));
    right.push(toLine(row.right));
  }
  return {
    left: { lines: left, hunks },
    right: { lines: right, hunks },
  };
}

/**
 * The text CodeMirror holds for a side: one line per row, and nothing else.
 *
 * No trailing newline, because a document line that no row describes would be a row
 * with no number in either file — a phantom line at the end of every diff.
 */
export function documentText(document: DiffDocument): string {
  return document.lines.map((line) => line.text).join('\n');
}

/** The 1-based document line a 1-based new-file line sits on, if the diff shows it. */
export function docLineForNew(document: DiffDocument, line: number): number | undefined {
  return docLineMatching(document, (row) => row.newAnchor === line);
}

/** The 1-based document line a 1-based old-file line sits on, if the diff shows it. */
export function docLineForOld(document: DiffDocument, line: number): number | undefined {
  return docLineMatching(document, (row) => row.oldLine === line);
}

/**
 * The line to reveal for a jump: the new file's first, because everything a reader
 * pins and reads points there; the old file's when the new side does not show it.
 */
export function revealDocLine(
  document: DiffDocument,
  line: number,
): number | undefined {
  return docLineForNew(document, line) ?? docLineForOld(document, line);
}

/**
 * Where a pin's `Notes`/`Cancel` pair could sit in one document, best first.
 *
 * `rank` 0 is a changed row on the pin's line — the corner a pin owns; 1 is any row on
 * it (a context row, when the block itself left nothing behind here). The caller
 * compares the ranks of the two sides of a split, so a deletion keeps its pair on the
 * deleted row instead of beside the unchanged line that followed it.
 */
export interface BandCandidate {
  readonly line: number;
  readonly rank: number;
}

/**
 * The rows a pin's pair could ride in this document, best first.
 *
 * Matching the anchor alone is not enough. Every row of a deletion block maps to the
 * same new-file line, so a pin ending there would paint a pair on each of them; the
 * last changed row on that line is the one corner the pair belongs on.
 */
export function bandCandidates(
  document: DiffDocument,
  pin: Pick<EditorPin, 'startLine' | 'endLine'>,
): BandCandidate[] {
  const end = pin.endLine ?? pin.startLine;
  let last = -1;
  let lastChange = -1;
  document.lines.forEach((row, index) => {
    if (row.newAnchor !== end) {
      return;
    }
    last = index;
    if (row.kind === 'add' || row.kind === 'del') {
      lastChange = index;
    }
  });
  const candidates: BandCandidate[] = [];
  if (lastChange >= 0) {
    candidates.push({ line: lastChange + 1, rank: 0 });
  }
  if (last >= 0 && last !== lastChange) {
    candidates.push({ line: last + 1, rank: 1 });
  }
  return candidates;
}

/** Whether a pin covers the change a row's anchor sits on. */
export function changePinned(
  pins: readonly EditorPin[],
  anchor: number | undefined,
): boolean {
  if (anchor === undefined) {
    return false;
  }
  return pins.some(
    (pin) =>
      pin.startLine !== undefined &&
      anchor >= pin.startLine &&
      anchor <= (pin.endLine ?? pin.startLine),
  );
}

/**
 * Whether a whole change block is already pinned: the range a click would pin is
 * the one an existing pin covers. A partially pinned block is still clickable — the
 * click extends the record to the block, it does not duplicate it.
 */
export function blockPinned(
  pins: readonly EditorPin[],
  change: { readonly start: number; readonly end: number } | undefined,
): boolean {
  if (change === undefined) {
    return false;
  }
  return pins.some(
    (pin) =>
      pin.startLine !== undefined &&
      pin.startLine <= change.start &&
      (pin.endLine ?? pin.startLine) >= change.end,
  );
}

function docLineMatching(
  document: DiffDocument,
  matches: (row: DiffLine) => boolean,
): number | undefined {
  const index = document.lines.findIndex(matches);
  return index < 0 ? undefined : index + 1;
}
