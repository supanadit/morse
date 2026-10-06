import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentUnavailableError } from '@morse/core';
import { PI_INSTALL_COMMAND, readPiVersion, resolvePi } from './resolve-pi.js';

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
