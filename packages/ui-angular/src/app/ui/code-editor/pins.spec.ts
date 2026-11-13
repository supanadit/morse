import { describe, expect, it } from 'vitest';
import { editorPins } from './pins';
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
