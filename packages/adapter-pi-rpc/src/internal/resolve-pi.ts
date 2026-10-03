import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { AgentUnavailableError } from '@morse/core';

export interface ResolvePiOptions {
  /** Explicit path to the `pi` binary (setting `morse.pi.path` / `MORSE_PI_PATH`). */
  piPath?: string;
  /** Run the bundled RPC entry with node instead of the `pi` binary. */
  nodeEntryPath?: string;
  /** Override the session directory (`--session-dir`). */
  sessionDir?: string;
  /** Do not persist a session (`--no-session`). */
  noSession?: boolean;
  /** Resume an existing session file (`--session <path>`). */
  sessionPath?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export type PiSpawnSource = 'configured' | 'path' | 'node-entry';

export interface PiSpawn {
  command: string;
  args: string[];
  source: PiSpawnSource;
}

export function buildRpcArgs(options: ResolvePiOptions): string[] {
  const args = ['--mode', 'rpc'];
  if (options.noSession) {
    args.push('--no-session');
  }
  if (options.sessionDir) {
    args.push('--session-dir', options.sessionDir);
  }
  if (options.sessionPath) {
    args.push('--session', options.sessionPath);
  }
  args.push(...(options.extraArgs ?? []));
  return args;
}

/**
 * Resolution order: explicit path, `node <rpc-entry>` when asked for, then the
 * `pi` binary on PATH. Everything else raises an actionable error instead of
 * failing later with a confusing spawn message.
 */
export function resolvePi(options: ResolvePiOptions = {}): PiSpawn {
  const env = options.env ?? process.env;
  const args = buildRpcArgs(options);
  const configured = options.piPath ?? env.MORSE_PI_PATH;
  if (configured) {
    return { command: configured, args, source: 'configured' };
  }

  const entry = options.nodeEntryPath ?? env.MORSE_PI_ENTRY;
  if (entry && isExecutableEntry(entry)) {
    return { command: process.execPath, args: [entry, ...args], source: 'node-entry' };
  }

  const onPath = findOnPath('pi', env);
  if (onPath) {
    return { command: onPath, args, source: 'path' };
  }

  throw new AgentUnavailableError(
    [
      'The pi coding agent was not found.',
      'Install it (`npm install -g @earendil-works/pi-coding-agent`) or point Morse at it:',
      '- VS Code: setting "morse.pi.path"',
      '- NestJS host: env MORSE_PI_PATH (or MORSE_PI_ENTRY for a bundled rpc-entry.js)',
    ].join('\n'),
  );
}

export function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.length === 0) {
    return undefined;
  }
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter((value) => value.length > 0)
      : [''];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`);
      if (isExecutableEntry(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function resolveSessionDir(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_SESSION_DIR;
  const value = configured ?? (fromEnv && fromEnv.length > 0 ? fromEnv : undefined);
  const base = value ?? join(homedir(), '.pi', 'agent', 'sessions');
  return isAbsolute(base) ? base : join(process.cwd(), base);
}

function isExecutableEntry(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
