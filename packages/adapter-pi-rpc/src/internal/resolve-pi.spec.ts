import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentUnavailableError } from '@morse/core';
import { PI_INSTALL_COMMAND, resolvePi } from './resolve-pi.js';

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
