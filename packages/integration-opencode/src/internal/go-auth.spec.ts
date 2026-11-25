import { describe, expect, it } from 'vitest';
import { readOpenCodeGoExport } from './go-auth.js';

/** What `opencode auth export` prints, with the secret replaced for the test. */
const EXPORTED = '[{"integrationID":"opencode-go","value":{"type":"key","key":"test-key"}}]';

describe('readOpenCodeGoExport', () => {
  it('reads the Go login from OpenCode’s own export, in memory only', () => {
    const calls: string[][] = [];
    expect(
      readOpenCodeGoExport((binary, args) => {
        calls.push([binary, ...args]);
        return EXPORTED;
      }),
    ).toBe(EXPORTED);
    expect(calls[0]?.slice(1)).toEqual(['auth', 'export', 'opencode-go']);
  });

  it('has nothing to import when there is no login or the export fails', () => {
    expect(readOpenCodeGoExport(() => '')).toBeUndefined();
    expect(
      readOpenCodeGoExport(() => {
        throw new Error('not logged in');
      }),
    ).toBeUndefined();
  });
});
