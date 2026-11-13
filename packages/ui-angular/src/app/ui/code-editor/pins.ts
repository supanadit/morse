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
