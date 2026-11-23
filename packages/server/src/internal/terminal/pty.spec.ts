import { describe, expect, it, vi } from 'vitest';

// A platform with no matching prebuild: loading the native module throws.
vi.mock('node:module', () => ({
  createRequire: () => () => {
    throw new Error('no prebuilt PTY');
  },
}));

describe('optional PTY loader', () => {
  it('reports no terminal instead of failing to load', async () => {
    const { ptyAvailable, spawnPty } = await import('./pty.js');
    expect(ptyAvailable).toBe(false);
    expect(() => spawnPty('/bin/sh', [], {})).toThrow(/no terminal/);
  });
});
