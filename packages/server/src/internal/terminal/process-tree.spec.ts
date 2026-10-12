import { describe, expect, it } from 'vitest';
import {
  descendantRows,
  parseProcessTable,
  sessionRows,
} from './process-tree.js';

describe('parseProcessTable', () => {
  it('reads pid/ppid/pgid/sid and ignores noise', () => {
    const raw = [
      '    1     0     1     1',
      '  100     1   100   100',
      '  200   100   200   100',
      '',
      'not a row',
    ].join('\n');

    expect(parseProcessTable(raw)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, sid: 1 },
      { pid: 100, ppid: 1, pgid: 100, sid: 100 },
      { pid: 200, ppid: 100, pgid: 200, sid: 100 },
    ]);
  });
});

describe('descendantRows', () => {
  it('walks the whole tree breadth-first', () => {
    // 10 is the shell; 11 (a wrapper) starts 12, and 20 is unrelated.
    const table = [
      { pid: 10, ppid: 1, pgid: 10, sid: 10 },
      { pid: 11, ppid: 10, pgid: 11, sid: 10 },
      { pid: 12, ppid: 11, pgid: 11, sid: 10 },
      { pid: 20, ppid: 1, pgid: 20, sid: 20 },
    ];

    expect(descendantRows(10, table).map((row) => row.pid)).toEqual([11, 12]);
  });

  it('does not follow a cycle back to the root', () => {
    const table = [
      { pid: 10, ppid: 1, pgid: 10, sid: 10 },
      { pid: 11, ppid: 10, pgid: 11, sid: 10 },
      // A malformed self-reference would loop forever without the seen guard.
      { pid: 10, ppid: 11, pgid: 10, sid: 10 },
    ];

    expect(descendantRows(10, table).map((row) => row.pid)).toEqual([11]);
  });
});

describe('sessionRows', () => {
  it("keeps a reparented orphan by its shared pty session, not its parent", () => {
    // 12 lost its parent (now ppid 1) but still shares the pty session (sid 10).
    const table = [
      { pid: 10, ppid: 1, pgid: 10, sid: 10 },
      { pid: 12, ppid: 1, pgid: 12, sid: 10 },
      { pid: 30, ppid: 1, pgid: 30, sid: 30 },
    ];

    expect(sessionRows(10, table).map((row) => row.pid)).toEqual([12]);
  });
});
