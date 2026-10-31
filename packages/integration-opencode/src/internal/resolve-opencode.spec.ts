import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOpenCodeBinary } from './resolve-opencode.js';

/**
 * Auto-detection is what decides whether an OpenCode engine exists at all, so a
 * missing binary must answer `undefined` (a pi-only host pays nothing) and a
 * present one must answer its path (the host can register it).
 */
describe('findOpenCodeBinary', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-opencode-bin-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeBinary(name: string, executable = true): string {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: executable ? 0o755 : 0o644 });
    chmodSync(path, executable ? 0o755 : 0o644);
    return path;
  }

  it('finds an executable on PATH and returns the candidate it found', () => {
    const path = fakeBinary('opencode');
    expect(findOpenCodeBinary('opencode', { PATH: `${dir}:/other` })).toBe(path);
  });

  it('ignores a non-executable entry and keeps looking', () => {
    const missing = join(dir, 'missing');
    const path = fakeBinary('opencode');
    expect(findOpenCodeBinary('opencode', { PATH: `${missing}:${dir}` })).toBe(path);
  });

  it('answers undefined when the binary is absent, so no engine registers', () => {
    expect(findOpenCodeBinary('opencode', { PATH: dir })).toBeUndefined();
    expect(findOpenCodeBinary('opencode', { PATH: '' })).toBeUndefined();
  });

  it('accepts an explicit path, and refuses a wrong one', () => {
    const path = fakeBinary('opencode');
    expect(findOpenCodeBinary(path, {})).toBe(path);
    expect(findOpenCodeBinary(join(dir, 'not-there'), {})).toBeUndefined();
  });
});
