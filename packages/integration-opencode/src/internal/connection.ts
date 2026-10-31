import { spawn, type ChildProcess } from 'node:child_process';
import { AgentUnavailableError } from '@morse/system';

/**
 * How Morse obtains an OpenCode server: attach to one the user configured, or
 * spawn a private one this process owns.
 *
 * OpenCode is not a subprocess-per-session harness like pi: it is a long-lived
 * HTTP server with Basic auth, and every session lives inside it. So the
 * connection is one per engine, not one per session, and its two modes have very
 * different lifetimes:
 *
 * - **Attached** (`MORSE_OPENCODE_URL`): a server someone else started (the TUI,
 *   a systemd unit). Morse authenticates, verifies it answers, and never stops
 *   it — that process is not Morse's to kill.
 * - **Owned** (no URL): Morse runs `opencode serve --hostname 127.0.0.1 --port 0`
 *   and reads the address and password the process announces. Disposing the
 *   engine stops it. A missing binary or a server that never announces itself is
 *   a setup problem, reported with what Morse looked for.
 *
 * Both modes fail as `AgentUnavailableError`: unreachable and unauthorized are
 * configuration mistakes to fix, not crashes to retry.
 */

/** How long a spawned server gets to print its two announcement lines. */
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
/** How long a verification request may take before the server is "unreachable". */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** How long a terminated owned server gets before it is killed outright. */
const KILL_GRACE_MS = 2_000;

export interface OpenCodeConnectionOptions {
  /** A server the user runs. When set, Morse attaches and never stops it. */
  url?: string;
  /** The password that server asks for (its Basic-auth secret). */
  password?: string;
  /** The binary to spawn when no URL is configured. Defaults to `opencode`. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export interface OpenCodeConnection {
  /** The server origin, without a trailing slash (e.g. `http://127.0.0.1:4096`). */
  readonly baseUrl: string;
  /** The password every request authenticates with. */
  readonly password: string;
  /** True when this connection started the server and must stop it. */
  readonly owned: boolean;
  /** Stops an owned server; a no-op for one Morse attached to. Idempotent. */
  close(): Promise<void>;
}

/** Path every API call hangs off; the server serves an HTML app outside it. */
export const OPENCODE_API_PREFIX = '/api';

/**
 * Resolves the server for an engine: attach + verify, or spawn + verify.
 *
 * Verification is deliberately a real authenticated request, not just a TCP
 * connect: a server that is up but rejects the password would otherwise fail at
 * the first session, far from the configuration mistake that caused it.
 */
export async function connectOpenCode(
  options: OpenCodeConnectionOptions = {},
): Promise<OpenCodeConnection> {
  if (options.url !== undefined) {
    return attach(options);
  }
  return spawnServer(options);
}

/** Attaches to a configured server, verifying it answers with these credentials. */
async function attach(options: OpenCodeConnectionOptions): Promise<OpenCodeConnection> {
  const baseUrl = normalizeUrl(options.url ?? '');
  const password = options.password?.trim();
  if (password === undefined || password.length === 0) {
    throw new AgentUnavailableError(
      `MORSE_OPENCODE_URL is ${baseUrl} but MORSE_OPENCODE_PASSWORD is not set. ` +
        'Set both to attach to a running OpenCode server.',
    );
  }
  try {
    await probe(baseUrl, password);
  } catch (error: unknown) {
    throw describeProbeFailure(baseUrl, error);
  }
  return {
    baseUrl,
    password,
    owned: false,
    close: () => Promise.resolve(),
  };
}

/** Spawns a private server and reads the address/password it announces. */
async function spawnServer(options: OpenCodeConnectionOptions): Promise<OpenCodeConnection> {
  const bin = options.bin?.trim() || 'opencode';
  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const announcement = await readAnnouncement(
      child,
      bin,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    try {
      await probe(announcement.url, announcement.password);
    } catch (error: unknown) {
      throw describeProbeFailure(announcement.url, error);
    }
    return {
      baseUrl: announcement.url,
      password: announcement.password,
      owned: true,
      close: () => stop(child),
    };
  } catch (error: unknown) {
    // A server Morse started but could not use must not leak: a half-started
    // process holding a port is worse than no process at all.
    await stop(child);
    throw error;
  }
}

/** The two lines `opencode serve` prints on startup. */
interface Announcement {
  url: string;
  password: string;
}

/**
 * Reads stdout until both announcement lines have been seen.
 *
 * A process that exits first (a bad install, a port clash) fails immediately with
 * its own stderr instead of waiting out the timeout, and the timeout itself fails
 * with the output so far — enough to see a prompt or an error the parser missed.
 */
function readAnnouncement(child: ChildProcess, bin: string, timeoutMs: number): Promise<Announcement> {
  return new Promise<Announcement>((resolve, reject) => {
    let output = '';
    let url: string | undefined;
    let password: string | undefined;
    let settled = false;

    const finish = (error: Error | undefined, announcement?: Announcement): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onErrorOutput);
      child.removeListener('error', onSpawnError);
      child.removeListener('exit', onExit);
      if (error !== undefined) {
        reject(error);
      } else if (announcement !== undefined) {
        resolve(announcement);
      }
    };

    const inspect = (): void => {
      url ??= /server listening on\s+(https?:\/\/\S+)/.exec(output)?.[1];
      password ??= /server password\s+(\S+)/.exec(output)?.[1];
      if (url !== undefined && password !== undefined) {
        finish(undefined, { url: normalizeUrl(url), password });
      }
    };

    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      inspect();
    };
    const onErrorOutput = (chunk: Buffer | string): void => {
      output += chunk.toString();
    };
    const onSpawnError = (error: Error): void => {
      finish(spawnFailure(bin, error));
    };
    const onExit = (code: number | null): void => {
      finish(
        new AgentUnavailableError(
          `OpenCode exited before announcing its address (${bin} serve exited with ${code ?? 'a signal'}).` +
            (output.trim().length > 0 ? `\n${tail(output)}` : ''),
        ),
      );
    };
    const timer = setTimeout(() => {
      finish(
        new AgentUnavailableError(
          `OpenCode did not announce its address and password within ${Math.round(timeoutMs / 1000)}s.` +
            (output.trim().length > 0 ? `\n${tail(output)}` : ''),
        ),
      );
    }, timeoutMs);

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onErrorOutput);
    child.on('error', onSpawnError);
    child.on('exit', onExit);
    inspect();
  });
}

/** One authenticated request that proves the server answers for these credentials. */
async function probe(baseUrl: string, password: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${OPENCODE_API_PREFIX}/session`, {
      headers: { authorization: basicAuth(password) },
      signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new UnreachableServer(error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UnauthorizedServer();
  }
  if (!response.ok) {
    throw new UnreachableServer(
      new Error(`the server answered ${response.status} ${response.statusText}`),
    );
  }
  // The body is irrelevant: authentication and routing are what the probe proves.
  await response.arrayBuffer().catch(() => undefined);
}

class UnreachableServer extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : 'the server did not answer');
    this.name = 'UnreachableServer';
  }
}

class UnauthorizedServer extends Error {
  constructor() {
    super('the server answered 401');
    this.name = 'UnauthorizedServer';
  }
}

function describeProbeFailure(baseUrl: string, error: unknown): AgentUnavailableError {
  if (error instanceof UnauthorizedServer) {
    return new AgentUnavailableError(
      `The OpenCode server at ${baseUrl} rejected the configured password. ` +
        'Set MORSE_OPENCODE_PASSWORD to the password that server printed.',
    );
  }
  if (error instanceof UnreachableServer) {
    return new AgentUnavailableError(
      `Morse could not reach the OpenCode server at ${baseUrl}. ` +
        'Start it (`opencode serve`) or clear MORSE_OPENCODE_URL to let Morse start its own.',
      { cause: error.failure },
    );
  }
  return new AgentUnavailableError(
    `Morse could not verify the OpenCode server at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/** A missing binary is a setup problem with a next step, like a missing `pi`. */
function spawnFailure(bin: string, error: Error): AgentUnavailableError {
  const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
  return new AgentUnavailableError(
    missing
      ? `Morse could not find the OpenCode binary "${bin}". Install OpenCode or set MORSE_OPENCODE_BIN.`
      : `Morse could not start "${bin} serve": ${error.message}`,
    {
      cause: error,
      ...(missing ? { remedy: { install: 'npm install -g opencode-ai' } } : {}),
    },
  );
}

/** Stops a server Morse started: SIGTERM, then SIGKILL if it will not go. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
  child.kill('SIGTERM');
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS)),
  ]);
  if (!killed) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
  }
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  // The server prints (and a user may paste) a URL without a scheme in rare
  // cases; a missing scheme is an http local server, not a filesystem path.
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function tail(output: string): string {
  return output.trim().split('\n').slice(-6).join('\n');
}

