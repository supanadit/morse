import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findOpenCodeBinary,
  findWindowsInstall,
  resolveOpenCodeSpawn,
} from './resolve-opencode.js';

/**
 * Auto-detection is what decides whether an OpenCode engine exists at all, so a
 * missing binary must answer `undefined` (a pi-only host pays nothing) and a
 * present one must answer with a way to start it (the host can register it).
 */

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A file and its directories, for fixtures whose paths mirror an install. */
function write(path: string, content = ''): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('findOpenCodeBinary on a POSIX machine', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir('morse-opencode-bin-');
  });

  function fakeBinary(name: string, executable = true): string {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: executable ? 0o755 : 0o644 });
    chmodSync(path, executable ? 0o755 : 0o644);
    return path;
  }

  it.skipIf(process.platform === 'win32')(
    'finds an executable on PATH and returns the candidate it found',
    () => {
      const path = fakeBinary('opencode');
      expect(findOpenCodeBinary('opencode', { PATH: `${dir}:/other` })).toBe(path);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'ignores a non-executable entry and keeps looking',
    () => {
      const missing = join(dir, 'missing');
      const path = fakeBinary('opencode');
      expect(findOpenCodeBinary('opencode', { PATH: `${missing}:${dir}` })).toBe(path);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers undefined when the binary is absent, so no engine registers',
    () => {
      expect(findOpenCodeBinary('opencode', { PATH: dir })).toBeUndefined();
      expect(findOpenCodeBinary('opencode', { PATH: '' })).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts an explicit path, and refuses a wrong one',
    () => {
      const path = fakeBinary('opencode');
      expect(findOpenCodeBinary(path, {})).toBe(path);
      expect(findOpenCodeBinary(join(dir, 'not-there'), {})).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')('starts the binary itself', () => {
    const path = fakeBinary('opencode');
    expect(resolveOpenCodeSpawn('opencode', { PATH: dir })).toEqual({ command: path, prefix: [] });
  });
});

/**
 * The reported Windows bug, end to end: `opencode` on PATH is an `opencode.cmd`
 * shim, which `spawn` cannot start (`EINVAL`), so the host found the binary and
 * then had no engine. The install is answered with the shim's file — keeping
 * detection honest — and with the program inside it as the thing to start.
 */
describe('binary resolution on Windows', () => {
  it.skipIf(process.platform !== 'win32')(
    'starts the .exe inside the npm shim it finds on PATH',
    () => {
      const dir = tempDir('morse-opencode-win-bin-');
      const exe = write(join(dir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
      write(
        join(dir, 'opencode.CMD'),
        [
          '@ECHO off',
          'CALL :find_dp0',
          '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*',
          '',
        ].join('\r\n'),
      );
      const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

      expect(findOpenCodeBinary('opencode', env)).toBe(join(dir, 'opencode.CMD'));
      expect(resolveOpenCodeSpawn('opencode', env)).toEqual({ command: exe, prefix: [] });
    },
  );
});

/**
 * Windows shims. npm's global install leaves `opencode` (POSIX sh), `opencode.cmd`
 * and `opencode.ps1` side by side, and a GUI host often has no `PATHEXT`. Node
 * refuses to start a `.cmd` without `cmd.exe`, so the shim has to be read and the
 * program inside it started instead. `process.platform` cannot be faked and CI
 * runs on Linux, so the Windows walk is tested directly.
 */
describe('findWindowsInstall', () => {
  /** Fixtures use the exact spelling `PATHEXT` yields, so this works on any OS. */
  function windowsDir(files: string[]): string {
    const dir = tempDir('morse-opencode-win-');
    for (const file of files) {
      write(join(dir, file));
    }
    return dir;
  }

  it('prefers a real .exe and starts it without a wrapper', () => {
    const dir = windowsDir(['opencode.EXE', 'opencode.CMD']);

    expect(findWindowsInstall('opencode', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toEqual({
      file: join(dir, 'opencode.EXE'),
      spawn: { command: join(dir, 'opencode.EXE'), prefix: [] },
    });
  });

  it('starts the executable an npm .cmd shim wraps, not the shim', () => {
    const dir = windowsDir(['opencode.CMD']);
    const exe = write(join(dir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
    writeFileSync(
      join(dir, 'opencode.CMD'),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*',
        '',
      ].join('\r\n'),
    );

    expect(findWindowsInstall('opencode', { PATH: dir })).toEqual({
      file: join(dir, 'opencode.CMD'),
      spawn: { command: exe, prefix: [] },
    });
  });

  it('runs the script an npm .cmd shim wraps on the node beside it', () => {
    const dir = windowsDir(['opencode.CMD']);
    const node = write(join(dir, 'node.exe'));
    const script = write(join(dir, 'node_modules', '@opencode', 'cli', 'cli.js'));
    writeFileSync(
      join(dir, 'opencode.CMD'),
      [
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        ')',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@opencode\\cli\\cli.js" %*',
        '',
      ].join('\r\n'),
    );

    expect(findWindowsInstall('opencode', { PATH: dir })?.spawn).toEqual({
      command: node,
      prefix: [script],
    });
  });

  it('falls back to cmd.exe for a shim whose body names nothing it can run', () => {
    const dir = windowsDir(['opencode.CMD']);

    expect(findWindowsInstall('opencode', { PATH: dir })?.spawn).toEqual({
      command: 'cmd.exe',
      prefix: ['/d', '/s', '/c', join(dir, 'opencode.CMD')],
    });
  });

  it('runs a lone .ps1 through powershell, since PATHEXT never lists it', () => {
    const dir = windowsDir(['opencode.ps1']);

    expect(
      findWindowsInstall('opencode', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })?.spawn,
    ).toEqual({
      command: 'powershell.exe',
      prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'opencode.ps1')],
    });
  });

  it('ignores the POSIX sh script npm leaves beside the shims', () => {
    const dir = windowsDir(['opencode']);

    expect(findWindowsInstall('opencode', { PATH: dir })).toBeUndefined();
  });

  it('still finds the .cmd shim when PATHEXT is absent', () => {
    const previous = process.env.PATHEXT;
    delete process.env.PATHEXT;
    try {
      const dir = windowsDir(['opencode.CMD']);

      expect(findWindowsInstall('opencode', { PATH: dir })?.file).toBe(join(dir, 'opencode.CMD'));
    } finally {
      if (previous !== undefined) {
        process.env.PATHEXT = previous;
      }
    }
  });

  it('reads Path as well as PATH, and returns undefined when nothing matches', () => {
    const dir = windowsDir(['opencode.CMD']);

    expect(findWindowsInstall('opencode', { Path: dir, PATHEXT: '.CMD' })?.file).toBe(
      join(dir, 'opencode.CMD'),
    );
    expect(findWindowsInstall('opencode', { PATH: windowsDir([]) })).toBeUndefined();
  });
});
