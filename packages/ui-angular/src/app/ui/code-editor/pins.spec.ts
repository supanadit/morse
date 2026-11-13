import { describe, expect, it } from 'vitest';
import { editorPins, noteLivesInFile } from './pins';
import type { PendingPin } from '../../state/attachments';

const pin = (over: Partial<PendingPin>): PendingPin => ({ id: 'p', path: 'a.ts', ...over }) as PendingPin;

describe('editorPins', () => {
  it('keeps only this file and sorts by line', () => {
    const out = editorPins(
      [
        pin({ id: 'b', startLine: 9 }),
        pin({ id: 'x', path: 'b.ts', startLine: 1 }),
        pin({ id: 'a', startLine: 2 }),
      ],
      'a.ts',
    );
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('drops a pin with no start line', () => {
    expect(editorPins([pin({ id: 'a' })], 'a.ts')).toEqual([]);
  });
  it('carries columns and the note through', () => {
    const [only] = editorPins(
      [pin({ id: 'a', startLine: 1, endLine: 2, startColumn: 3, endColumn: 4, note: 'why' })],
      'a.ts',
    );
    expect(only).toEqual({ id: 'a', startLine: 1, endLine: 2, startColumn: 3, endColumn: 4, note: 'why' });
  });
});

describe('noteLivesInFile', () => {
  const base = { filePreview: true };
  it('writes the note in the card when the host has an editor', () => {
    expect(noteLivesInFile(base)).toBe(true);
  });
  it('keeps the chip when the host has no editor (VS Code)', () => {
    expect(noteLivesInFile({ filePreview: false })).toBe(false);
  });
  it('keeps the chip for a binary file, which has no editor', () => {
    expect(noteLivesInFile({ ...base, binary: true })).toBe(false);
  });
  it('keeps the chip while the file is loading or failed to read', () => {
    expect(noteLivesInFile({ ...base, loading: true })).toBe(false);
    expect(noteLivesInFile({ ...base, error: 'Could not read this file.' })).toBe(false);
  });
});
