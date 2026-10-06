import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
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

/**
 * How to install the agent. The error message and the `remedy` both spell it out
 * from here, so what the setup screen offers and what the log says cannot drift.
 */
export const PI_INSTALL_COMMAND = 'npm install -g @earendil-works/pi-coding-agent';

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
      `Install it (\`${PI_INSTALL_COMMAND}\`) or point Morse at it:`,
      '- VS Code: setting "morse.pi.path"',
      '- NestJS host: env MORSE_PI_PATH (or MORSE_PI_ENTRY for a bundled rpc-entry.js)',
    ].join('\n'),
    { remedy: { install: PI_INSTALL_COMMAND } },
  );
}

export interface PiCliSpawn {
  command: string;
  /** Arguments that select pi itself, before the subcommand (the node RPC entry). */
  baseArgs: string[];
  source: PiSpawnSource;
}

/**
 * The `pi` CLI, for the subcommands Morse runs *outside* a session (`pi mcp ...`).
 *
 * Not `resolvePi`: that one builds `--mode rpc`, which the CLI would treat as an
 * RPC session rather than a subcommand. A configured path or the binary on PATH
 * is used directly; a bundled RPC entry is only useful for `--mode rpc`, so its
 * sibling `cli.js` is preferred and a clear error is raised when there is none.
 */
export function resolvePiCli(options: ResolvePiOptions = {}): PiCliSpawn {
  const env = options.env ?? process.env;
  const configured = options.piPath ?? env.MORSE_PI_PATH;
  if (configured) {
    return { command: configured, baseArgs: [], source: 'configured' };
  }

  const onPath = findOnPath('pi', env);
  if (onPath) {
    return { command: onPath, baseArgs: [], source: 'path' };
  }

  const entry = options.nodeEntryPath ?? env.MORSE_PI_ENTRY;
  const cli = entry ? siblingCliEntry(entry) : undefined;
  if (cli) {
    return { command: process.execPath, baseArgs: [cli], source: 'node-entry' };
  }

  throw new AgentUnavailableError(
    [
      'The pi CLI was not found, so Morse cannot run `pi mcp`.',
      `Install it (\`${PI_INSTALL_COMMAND}\`) or point Morse at it:`,
      '- VS Code: setting "morse.pi.path"',
      '- NestJS host: env MORSE_PI_PATH',
    ].join('\n'),
    { remedy: { install: PI_INSTALL_COMMAND } },
  );
}

/** `.../dist/bundle/rpc-entry.js` -> `.../dist/bundle/cli.js` when it exists. */
function siblingCliEntry(entry: string): string | undefined {
  const directory = dirname(entry);
  const cli = join(directory, 'cli.js');
  return entry.endsWith('rpc-entry.js') && isExecutableEntry(cli) ? cli : undefined;
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

/**
 * The installed pi version, read from the npm package that owns the resolved
 * entry (`pi` is a symlink to `.../@earendil-works/pi-coding-agent/dist/bundle/cli.js`,
 * so its `package.json` sits two directories up). Best effort: a pi installed by
 * a package manager that does not leave a readable package.json next to the
 * binary simply has no version, and the only cost is the frontend's "a newer pi
 * is out" notice.
 *
 * Not `pi --version`: this runs while a host builds its capabilities, and a
 * subprocess there would delay every connection. Reading one file does not.
 */
export function readPiVersion(spawn: PiSpawn): string | undefined {
  const entry = spawn.source === 'node-entry' ? spawn.args.find((arg) => /\.(?:c|m)?js$/.test(arg)) : spawn.command;
  if (entry === undefined || entry.length === 0) {
    return undefined;
  }
  let directory: string | undefined;
  try {
    const resolved = realpathSync(entry);
    directory = statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  } catch {
    directory = dirname(entry);
  }
  // The package root is at most a couple of levels above the entry; walking a
  // fixed few and stopping keeps this from climbing to the filesystem root.
  for (let depth = 0; depth < 4 && directory !== undefined && directory !== dirname(directory); depth += 1) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const version = versionFromManifest(manifest);
      if (version !== undefined) {
        return version;
      }
    }
    directory = dirname(directory);
  }
  return undefined;
}

/** The version of the package pi ships as, when this manifest is that package. */
function versionFromManifest(path: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (manifest.name === '@earendil-works/pi-coding-agent' && typeof manifest.version === 'string') {
      return manifest.version.trim() || undefined;
    }
  } catch {
    // Unreadable or not JSON: keep walking.
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
