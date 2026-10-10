import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDrafts, readWorkbench, saveDrafts, saveWorkbench } from './workbench-store.js';

/**
 * The layout store is what makes a reopened window land on the session the reader
 * left instead of an empty panel. It is shared by both hosts now, so what matters
 * here is the envelope contract: a versioned `{ version, data }` blob round-trips,
 * anything else reads back as "nothing to restore" instead of an error, and a
 * bad save is rejected rather than written.
 */
describe('workbench store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-workbench-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a layout and keeps layout and drafts apart', () => {
    const layout = { version: 1, data: { tabs: { tabs: [], activeId: 's1' } } };
    const drafts = { version: 1, data: { s1: { text: 'half a prompt' } } };

    expect(saveWorkbench(dir, layout)).toBe(true);
    expect(saveDrafts(dir, drafts)).toBe(true);

    expect(readWorkbench(dir)).toEqual(layout);
    expect(readDrafts(dir)).toEqual(drafts);
  });

  it('reads a missing or unreadable file as nothing to restore', () => {
    expect(readWorkbench(dir)).toBeUndefined();
    expect(readDrafts(dir)).toBeUndefined();
  });

  it('drops an envelope that is not a versioned { version, data } object', () => {
    expect(() => saveWorkbench(dir, { data: {} })).toThrow();
    expect(() => saveWorkbench(dir, { version: 0, data: {} })).toThrow();
    expect(readWorkbench(dir)).toBeUndefined();
  });

  it('overwrites the previous layout atomically, leaving no temp file behind', () => {
    saveWorkbench(dir, { version: 1, data: { activeId: 'first' } });
    saveWorkbench(dir, { version: 1, data: { activeId: 'second' } });

    expect(readWorkbench(dir)).toEqual({ version: 1, data: { activeId: 'second' } });
  });
});
