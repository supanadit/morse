import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_BUFFER_CHARS } from '@morse/host-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readTerminalLog,
  removeTerminalLog,
  safeTerminalName,
  writeTerminalLog,
} from './terminal-log.js';

/** The on-disk scrollback: what makes a terminal's output survive the host. */
describe('terminal log', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'morse-terminal-log-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes a scrollback and reads it back', () => {
    writeTerminalLog(dataDir, 'term-1', 'hello\nworld\n');

    expect(readTerminalLog(dataDir, 'term-1')).toBe('hello\nworld\n');
  });

  it('reads an empty string for a terminal that has no log', () => {
    expect(readTerminalLog(dataDir, 'term-404')).toBe('');
  });

  it('overwrites rather than appends, so a restart replays only the tail', () => {
    writeTerminalLog(dataDir, 'term-1', 'first\n');
    writeTerminalLog(dataDir, 'term-1', 'second\n');

    expect(readTerminalLog(dataDir, 'term-1')).toBe('second\n');
  });

  it('caps the file at four times the in-memory replay', () => {
    const max = TERMINAL_BUFFER_CHARS * 4;
    writeTerminalLog(dataDir, 'term-1', 'a'.repeat(max + 5_000));

    const read = readTerminalLog(dataDir, 'term-1');
    expect(read.length).toBeLessThanOrEqual(max);
    // No newline to cut at, so the raw tail is kept.
    expect(read).toBe('a'.repeat(read.length));
  });

  it('forgets a terminal on close', () => {
    writeTerminalLog(dataDir, 'term-1', 'bye\n');
    removeTerminalLog(dataDir, 'term-1');

    expect(readTerminalLog(dataDir, 'term-1')).toBe('');
  });

  it('never lets an untrusted id escape the log directory', () => {
    // A `../` must not become a path; an empty id still names a file.
    expect(safeTerminalName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeTerminalName('term-3')).toBe('term-3');
    expect(safeTerminalName('')).toBe('terminal');
  });
});
