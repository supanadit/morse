import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentUnavailableError } from '@morse/core';
import { findWindowsShim, PI_INSTALL_COMMAND, readPiVersion, resolvePi } from './resolve-pi.js';

/**
 * `resolvePi` is the one place that decides what Morse will actually run, and the
 * only place that knows pi's package name. The setup screen renders
 * `remedy.install` as a copyable command while the log prints the message, so both
 * have to say the same thing — that is why the constant exists.
 */

const tempDirs: string[] = [];

function fakePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-pi-'));
  tempDirs.push(dir);
  const binary = join(dir, 'pi');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolvePi', () => {
  it('raises the missing agent with the install command as its remedy', () => {
    let caught: unknown;
    try {
      resolvePi({ env: { PATH: join(tmpdir(), 'morse-definitely-not-here') } });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentUnavailableError);
    const unavailable = caught as AgentUnavailableError;
    expect(unavailable.code).toBe('agent-unavailable');
    expect(unavailable.message).toContain(PI_INSTALL_COMMAND);
    expect(unavailable.remedy).toEqual({ install: PI_INSTALL_COMMAND });
  });

  it('takes a configured path as given — the user knows where their pi is', () => {
    expect(resolvePi({ piPath: '/opt/pi/bin/pi' })).toEqual({
      command: '/opt/pi/bin/pi',
      args: ['--mode', 'rpc'],
      source: 'configured',
    });
  });

  it('finds pi on PATH and passes the session options as pi flags', () => {
    const directory = fakePath();

    expect(resolvePi({ env: { PATH: directory } })).toEqual({
      command: join(directory, 'pi'),
      args: ['--mode', 'rpc'],
      source: 'path',
    });
    expect(
      resolvePi({ env: { PATH: directory }, sessionDir: '/sessions', extraArgs: ['--verbose'] }).args,
    ).toEqual(['--mode', 'rpc', '--session-dir', '/sessions', '--verbose']);
  });
});

/** A fake installed pi package: `package.json` two levels above the entry. */
function fakePiPackage(version = '1.0.3'): { entry: string; binary: string } {
  const root = mkdtempSync(join(tmpdir(), 'morse-pi-pkg-'));
  tempDirs.push(root);
  const bundle = join(root, 'dist', 'bundle');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }),
  );
  const entry = join(bundle, 'cli.js');
  writeFileSync(entry, '#!/usr/bin/env node\n');
  const binary = join(root, 'bin-pi');
  symlinkSync(entry, binary);
  return { entry, binary };
}

describe('readPiVersion', () => {
  it('reads the version from the package that owns a node entry', () => {
    const { entry } = fakePiPackage('1.2.3');

    expect(
      readPiVersion({ command: process.execPath, args: [entry, '--mode', 'rpc'], source: 'node-entry' }),
    ).toBe('1.2.3');
  });

  it('follows a symlinked pi binary to its package', () => {
    const { binary } = fakePiPackage('9.9.9');

    expect(readPiVersion({ command: binary, args: [], source: 'path' })).toBe('9.9.9');
  });

  it('stays undefined when the manifest is not pi’s, or is unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'morse-not-pi-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'something-else', version: '2.0.0' }));
    const binary = join(root, 'pi');
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });

    expect(readPiVersion({ command: binary, args: [], source: 'configured' })).toBeUndefined();
    expect(
      readPiVersion({ command: join(root, 'missing'), args: [], source: 'path' }),
    ).toBeUndefined();
  });
});

/**
 * Windows shims. npm's global install leaves `pi` (sh), `pi.cmd` and `pi.ps1`
 * side by side in `%APPDATA%\npm`, and `PATHEXT` — a shell variable — is often
 * missing from a GUI process. Each shim needs different spawn treatment, so
 * `findWindowsShim` is tested directly rather than through `resolvePi`, whose
 * platform branch cannot be faked.
 */
describe('findWindowsShim', () => {
  function windowsDir(files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'morse-pi-win-'));
    tempDirs.push(dir);
    for (const file of files) {
      writeFileSync(join(dir, file), '');
    }
    return dir;
  }

  /**
   * Windows is case-insensitive, so `pi.CMD` (what `PATHEXT` yields) matches the
   * lowercase `pi.cmd` npm writes. A POSIX test filesystem is not, so when a case
   * differs we materialise the probe's exact spelling with a hard link to keep
   * the fixture honest without duplicating data.
   */
  function windowsDirCaseInsensitive(files: string[]): string {
    const dir = windowsDir(files);
    for (const file of files) {
      // Uppercase only the extension, the casing `PATHEXT` uses (`.CMD`, `.EXE`).
      const dot = file.lastIndexOf('.');
      const upperName = dot < 0 ? file : `${file.slice(0, dot)}${file.slice(dot).toUpperCase()}`;
      const upper = join(dir, upperName);
      if (upper !== join(dir, file)) {
        symlinkSync(join(dir, file), upper);
      }
    }
    return dir;
  }

  it('prefers a real .exe and starts it without a shell', () => {
    const dir = windowsDirCaseInsensitive(['pi.cmd', 'pi.exe']);

    expect(findWindowsShim('pi', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toEqual({
      command: join(dir, 'pi.EXE'),
      prefix: [],
      shell: false,
    });
  });

  it('falls back to the .cmd shim and marks it as needing a shell', () => {
    const dir = windowsDirCaseInsensitive(['pi.cmd']);

    expect(findWindowsShim('pi', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toEqual({
      command: join(dir, 'pi.CMD'),
      prefix: [],
      shell: true,
    });
  });

  it('still finds the .cmd shim when PATHEXT is absent', () => {
    const dir = windowsDirCaseInsensitive(['pi.cmd']);

    expect(findWindowsShim('pi', { PATH: dir })).toEqual({
      command: join(dir, 'pi.CMD'),
      prefix: [],
      shell: true,
    });
  });

  it('runs a lone .ps1 through powershell, since PATHEXT never lists it', () => {
    const dir = windowsDir(['pi.ps1']);
    const shim = findWindowsShim('pi', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

    expect(shim).toEqual({
      command: 'powershell.exe',
      prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'pi.ps1')],
      shell: false,
    });
  });

  it('prefers .cmd over .ps1 when both exist', () => {
    const dir = windowsDirCaseInsensitive(['pi.cmd', 'pi.ps1']);

    expect(findWindowsShim('pi', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })?.command).toBe(
      join(dir, 'pi.CMD'),
    );
  });

  it('reads Path as well as PATH, and returns undefined when nothing matches', () => {
    const dir = windowsDirCaseInsensitive(['pi.cmd']);

    expect(findWindowsShim('pi', { Path: dir, PATHEXT: '.CMD' })?.command).toBe(join(dir, 'pi.CMD'));
    expect(findWindowsShim('pi', { PATH: windowsDir([]) })).toBeUndefined();
  });
});

/**
 * A Windows `.cmd` shim is a script, not the package, so the manifest is not
 * beside it. npm names the real entry inside, and `readPiVersion` follows that.
 */
describe('readPiVersion on a Windows shim', () => {
  it('follows the node_modules path written inside a .cmd shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'morse-pi-cmd-'));
    tempDirs.push(root);
    const pkg = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
    mkdirSync(join(pkg, 'dist', 'bundle'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '4.5.6' }));
    const shim = join(root, 'pi.cmd');
    writeFileSync(
      shim,
      `@ECHO off\r\nnode "%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n`,
    );

    expect(readPiVersion({ command: shim, args: [], source: 'path' })).toBe('4.5.6');
  });
});
