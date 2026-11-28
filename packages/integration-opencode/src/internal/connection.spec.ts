import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentUnavailableError } from '@morse/system';
import {
  connectOpenCode,
  OPENCODE_INSTALL_COMMAND,
  type OpenCodeConnection,
} from './connection.js';

/**
 * The connection is where an OpenCode setup mistake becomes an actionable error:
 * an unreachable or wrongly-passworded server must not surface later as a failed
 * prompt, and a server Morse started itself must never outlive the engine. Both
 * are tested here against a real local HTTP server and a real spawned script —
 * the two moving parts a mock would hide.
 */

const PASSWORD = 'secret-password';

/**
 * A server that checks Basic auth and answers the probe like OpenCode does. The
 * password may be read per request, for a server whose password Morse chooses
 * after the fake exists.
 */
async function startFakeServer(password: string | (() => string) = PASSWORD): Promise<{
  url: string;
  server: Server;
  close: () => Promise<void>;
  requests: () => number;
}> {
  let requests = 0;
  const expectedFor = (): string => {
    const secret = typeof password === 'function' ? password() : password;
    return `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`;
  };
  const server = createServer((request, response) => {
    requests += 1;
    if (request.headers.authorization !== expectedFor()) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":"unauthorized"}');
      return;
    }
    if (request.url?.startsWith('/api/session')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests: () => requests,
  };
}

/**
 * A stand-in for `opencode serve`: prints what the real one announces.
 *
 * Windows gets the shape npm actually installs — a `.cmd` shim around a `.js` —
 * because Node cannot start a `.cmd` itself and unwrapping one is what the
 * resolver exists for. Elsewhere it is the same script with a shebang.
 */
function fakeBinary(dir: string): string {
  const body = `const fs = require('node:fs');
process.on('SIGTERM', () => {
  fs.writeFileSync(process.env.FAKE_OC_STOP_FILE, 'stopped');
  process.exit(0);
});
if (process.env.FAKE_OC_EXIT === '1') {
  console.error('bind: address already in use');
  process.exit(3);
} else if (process.env.FAKE_OC_SILENT === '1') {
  setInterval(() => {}, 1000);
} else {
  // Like every real build: the password in OPENCODE_SERVER_PASSWORD is the one
  // checked. Only 2.x also announces it; 1.19 prints the address alone.
  fs.writeFileSync(process.env.FAKE_OC_PASSWORD_FILE, process.env.OPENCODE_SERVER_PASSWORD);
  console.log('server listening on ' + process.env.FAKE_OC_URL);
  if (process.env.FAKE_OC_ANNOUNCE_PASSWORD === '1') {
    console.log('server password ' + process.env.OPENCODE_SERVER_PASSWORD);
  }
  setInterval(() => {}, 1000);
}
`;
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'fake-opencode.js'), body);
    const shim = join(dir, 'fake-opencode.cmd');
    writeFileSync(shim, '@ECHO off\r\n"%~dp0fake-opencode.js" %*\r\n');
    return shim;
  }
  const path = join(dir, 'fake-opencode');
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe('connectOpenCode', () => {
  let dir: string;
  let connection: OpenCodeConnection | undefined;

  /**
   * The stop file is the fake server's proof that it was *asked* to stop, which
   * needs a delivered SIGTERM. Windows terminates a process instead of delivering
   * one, so a JavaScript handler never runs there; the server is still stopped,
   * just not gracefully, and only POSIX can observe the difference.
   */
  const gracefulStop = process.platform !== 'win32';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-opencode-connection-'));
  });

  afterEach(async () => {
    await connection?.close();
    connection = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('attaches to a configured server, verifying its password, and never stops it', async () => {
    const fake = await startFakeServer();
    try {
      connection = await connectOpenCode({ url: fake.url, password: PASSWORD });
      expect(connection).toMatchObject({ baseUrl: fake.url, password: PASSWORD, owned: false });
      expect(fake.requests()).toBe(1);

      // Disposing an attached connection must leave the user's server running.
      await connection.close();
      const after = await fetch(`${fake.url}/api/session`, {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`,
        },
      });
      expect(after.status).toBe(200);
    } finally {
      await fake.close();
    }
  });

  it('accepts a pasted URL with a trailing slash', async () => {
    const fake = await startFakeServer();
    try {
      connection = await connectOpenCode({ url: `${fake.url}/`, password: PASSWORD });
      expect(connection.baseUrl).toBe(fake.url);
    } finally {
      await fake.close();
    }
  });

  it('reports a rejected password as a configuration problem', async () => {
    const fake = await startFakeServer();
    try {
      await expect(connectOpenCode({ url: fake.url, password: 'wrong' })).rejects.toThrow(
        /rejected the configured password/,
      );
      await expect(connectOpenCode({ url: fake.url, password: 'wrong' })).rejects.toBeInstanceOf(
        AgentUnavailableError,
      );
    } finally {
      await fake.close();
    }
  });

  it('reports an unreachable server with what to do about it', async () => {
    // Bind then close, so the port is valid but nothing answers.
    const fake = await startFakeServer();
    const url = fake.url;
    await fake.close();
    await expect(connectOpenCode({ url, password: PASSWORD })).rejects.toThrow(
      /could not reach the OpenCode server/,
    );
  });

  it('refuses a URL without a password', async () => {
    await expect(connectOpenCode({ url: 'http://127.0.0.1:4096' })).rejects.toThrow(
      /MORSE_OPENCODE_PASSWORD is not set/,
    );
  });

  it('spawns, keys, verifies and stops its own server', async () => {
    // A 2.x build: announces the address and the password Morse set.
    const passwordFile = join(dir, 'password');
    const fake = await startFakeServer(() => readFileSync(passwordFile, 'utf8'));
    const stopFile = join(dir, 'stopped');
    try {
      connection = await connectOpenCode({
        bin: fakeBinary(dir),
        env: {
          ...process.env,
          FAKE_OC_URL: fake.url,
          FAKE_OC_PASSWORD_FILE: passwordFile,
          FAKE_OC_ANNOUNCE_PASSWORD: '1',
          FAKE_OC_STOP_FILE: stopFile,
        },
      });
      const chosen = readFileSync(passwordFile, 'utf8');
      expect(chosen.length).toBeGreaterThanOrEqual(16);
      expect(connection).toMatchObject({ baseUrl: fake.url, password: chosen, owned: true });

      await connection.close();
      connection = undefined;
      // The spawned process is gone, not just detached.
      expect(existsSync(stopFile)).toBe(gracefulStop);
    } finally {
      await fake.close();
    }
  });

  it('keys the server itself for a build that announces no password', async () => {
    // 1.19: honours OPENCODE_SERVER_PASSWORD but prints only its address —
    // unsecured, and nothing to wait for, unless the password arrives in its env.
    const passwordFile = join(dir, 'password');
    const stopFile = join(dir, 'stopped');
    const fake = await startFakeServer(() => readFileSync(passwordFile, 'utf8'));
    try {
      connection = await connectOpenCode({
        bin: fakeBinary(dir),
        env: {
          ...process.env,
          FAKE_OC_URL: fake.url,
          FAKE_OC_PASSWORD_FILE: passwordFile,
          FAKE_OC_STOP_FILE: stopFile,
        },
      });
      const chosen = readFileSync(passwordFile, 'utf8');
      expect(chosen.length).toBeGreaterThanOrEqual(16);
      expect(connection).toMatchObject({ baseUrl: fake.url, password: chosen, owned: true });

      await connection.close();
      connection = undefined;
      expect(existsSync(stopFile)).toBe(gracefulStop);
    } finally {
      await fake.close();
    }
  });

  it('fails a silent server after the timeout and cleans the process up', async () => {
    const stopFile = join(dir, 'stopped');
    await expect(
      connectOpenCode({
        bin: fakeBinary(dir),
        env: { ...process.env, FAKE_OC_SILENT: '1', FAKE_OC_STOP_FILE: stopFile },
        startupTimeoutMs: 200,
      }),
    ).rejects.toThrow(/did not announce its address/);
    expect(existsSync(stopFile)).toBe(gracefulStop);
  });

  it('fails immediately when the server exits, with its own output', async () => {
    await expect(
      connectOpenCode({
        bin: fakeBinary(dir),
        env: { ...process.env, FAKE_OC_EXIT: '1' },
        startupTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited with 3[\s\S]*address already in use/);
  });

  it('names the missing binary and offers the install step', async () => {
    const error = await connectOpenCode({ bin: join(dir, 'not-installed') }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as Error).message).toContain('not-installed');
    expect((error as AgentUnavailableError).remedy?.install).toBe(OPENCODE_INSTALL_COMMAND);
  });
});
