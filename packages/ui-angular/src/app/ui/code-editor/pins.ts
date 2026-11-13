/**
 * The pins an editor shows: the store's pins narrowed to one file, ordered by
 * line so cards and tints can be laid out top to bottom.
 */
import type { PendingPin } from '../../state/attachments';

/** One range the editor draws a tint and a note card for. */
export interface EditorPin {
  readonly id: string;
  readonly startLine: number;
  readonly endLine?: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
  readonly note?: string;
}

/** This file's pins, in line order; other files' pins and line-less ones are dropped. */
export function editorPins(pins: readonly PendingPin[], path: string): EditorPin[] {
  const out: EditorPin[] = [];
  for (const pin of pins) {
    if (pin.path !== path || pin.startLine === undefined) {
      continue;
    }
    out.push({
      id: pin.id,
      startLine: pin.startLine,
      ...(pin.endLine !== undefined ? { endLine: pin.endLine } : {}),
      ...(pin.startColumn !== undefined ? { startColumn: pin.startColumn } : {}),
      ...(pin.endColumn !== undefined ? { endColumn: pin.endColumn } : {}),
      ...(pin.note !== undefined ? { note: pin.note } : {}),
    });
  }
  return out.sort((a, b) => a.startLine - b.startLine || a.id.localeCompare(b.id));
}

/**
 * Whether a pin's note is written in the file (the card beside the code) rather
 * than on the composer chip. The chip keeps the editor only where there is no
 * card to reach: no file tab at all, or a file the editor cannot show. Getting
 * this wrong strands a note with no surface, so it is a pure function with a
 * test for every combination.
 */
export function noteLivesInFile(input: {
  filePreview: boolean;
  binary?: boolean;
  error?: string;
  loading?: boolean;
}): boolean {
  return input.filePreview && input.binary !== true && input.error === undefined && input.loading !== true;
}
