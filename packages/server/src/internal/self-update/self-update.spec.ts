import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MORSE_PACKAGE,
  canSelfUpdate,
  cliEntry,
  helperSource,
  performSelfUpdate,
  runningVersion,
} from './self-update.js';

/** The pure parts of one-click self-update: version discovery and the helper text. */
describe('runningVersion', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morse-self-update-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the version from the published package, not an inner workspace package', () => {
    // The published artifact's package.json names the npm package.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: MORSE_PACKAGE, version: '1.2.3' }),
    );

    expect(runningVersion(root)).toBe('1.2.3');
  });

  it('ignores an unrelated package and keeps walking up', () => {
    const inner = join(root, 'packages', 'server', 'dist');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: MORSE_PACKAGE, version: '1.2.3' }));
    // A nested package that is not ours must not answer.
    writeFileSync(join(root, 'packages', 'package.json'), JSON.stringify({ name: '@morse/server', version: '9.9.9' }));

    expect(runningVersion(inner)).toBe('1.2.3');
  });

  it('answers undefined when nothing above names the package', () => {
    expect(runningVersion(root)).toBeUndefined();
  });
});

describe('cliEntry', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morse-self-update-cli-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('points at dist/cli.mjs beside the package when it exists', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: MORSE_PACKAGE }));
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'cli.mjs'), '// cli');

    expect(cliEntry(root)).toBe(join(dist, 'cli.mjs'));
  });

  it('answers undefined when the CLI is not beside the bundle', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: MORSE_PACKAGE }));

    expect(cliEntry(root)).toBeUndefined();
  });
});

describe('canSelfUpdate', () => {
  it('refuses unless MORSE_SELF_UPDATE opts in', async () => {
    await expect(canSelfUpdate({})).resolves.toBe(false);
    await expect(canSelfUpdate({ MORSE_SELF_UPDATE: '0' })).resolves.toBe(false);
    await expect(canSelfUpdate({ MORSE_SELF_UPDATE: 'off' })).resolves.toBe(false);
  });
});

describe('performSelfUpdate', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'morse-self-update-run-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses, without spawning, when there is no CLI to relaunch', async () => {
    const spawn = vi.fn();
    const exit = vi.fn();

    const result = await performSelfUpdate({
      dataDir,
      currentVersion: '1.0.0',
      // The test's own module has no sibling morse package.json.
      spawn: spawn as never,
      exit: exit as never,
    });

    expect(result.ok).toBe(false);
    expect(result.from).toBe('1.0.0');
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('stages a helper that installs then restarts, and exits after answering', async () => {
    // The helper text is deterministic, so assert its promises directly rather
    // than running it: it would install a real package over the network.
    const source = helperSource('/home/u/.morse');

    expect(source).toContain("'install', '-g', '@supanadit/morse-web@latest'");
    expect(source).toContain("'start'");
    expect(source).toContain('waitForExit');
    // The helper writes its own log beside the daemon's, in the data directory.
    expect(source).toContain('join("/home/u/.morse", \'self-update.log\')');
  });
});
