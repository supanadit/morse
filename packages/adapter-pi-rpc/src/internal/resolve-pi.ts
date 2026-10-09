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
  /**
   * True when the command is a `.cmd`/`.bat` shim that Windows `CreateProcess`
   * cannot start directly and must go through `cmd.exe` (spawn `shell: true`).
   */
  shell?: boolean;
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

  const onPath = findOnPathBinary('pi', env);
  if (onPath) {
    return {
      command: onPath.command,
      args: [...onPath.prefix, ...args],
      source: 'path',
      ...(onPath.shell ? { shell: true } : {}),
    };
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
  /** True for a Windows `.cmd`/`.bat` shim that needs `shell: true`. */
  shell?: boolean;
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

  const onPath = findOnPathBinary('pi', env);
  if (onPath) {
    return {
      command: onPath.command,
      baseArgs: onPath.prefix,
      source: 'path',
      ...(onPath.shell ? { shell: true } : {}),
    };
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

/**
 * How a Windows shim has to be started. npm's global install leaves several
 * kinds of `pi` next to each other in `%APPDATA%\npm`:
 *
 * - `pi`      POSIX sh script, only usable from Git Bash/MSYS/WSL, not Node.
 * - `pi.cmd`  batch shim; `CreateProcess` cannot start it without `cmd.exe`,
 *             so `spawn` needs `shell: true`.
 * - `pi.ps1`  PowerShell script; never in `PATHEXT` and never directly
 *             executable — it must go through `powershell -File`.
 * - `pi.exe`  a real executable (native build), started as-is.
 */
type WinShim = { command: string; prefix: string[]; shell: boolean };

/** `PATHEXT` is a shell variable and is often absent from GUI processes. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * A Windows path that names an executable we can actually start, plus how to
 * start it. `.ps1` is probed explicitly because `PATHEXT` deliberately omits it,
 * and is only used when nothing better exists — its execution policy can block
 * it and it costs a `powershell` process. Exported for the test.
 */
export function findWindowsShim(binary: string, env: NodeJS.ProcessEnv): WinShim | undefined {
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.length === 0) {
    return undefined;
  }
  const pathExt = windowsExtensions(env);
  // `path.delimiter` is `:` off Windows, so split on `;` explicitly here.
  const directories = pathValue.split(';');

  // Walk extensions in `PATHEXT` order so a real `.exe` wins over a `.cmd`.
  for (const directory of directories) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of pathExt) {
      const candidate = join(directory, `${binary}${extension}`);
      if (!isExecutableEntry(candidate)) {
        continue;
      }
      const lowered = extension.toLowerCase();
      if (lowered === '.exe' || lowered === '.com') {
        return { command: candidate, prefix: [], shell: false };
      }
      if (lowered === '.cmd' || lowered === '.bat') {
        return { command: candidate, prefix: [], shell: true };
      }
    }
  }

  // `.ps1` is not in `PATHEXT`; probe it explicitly, last among Windows shims.
  for (const directory of directories) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, `${binary}.ps1`);
    if (isExecutableEntry(candidate)) {
      return {
        command: 'powershell.exe',
        prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', candidate],
        shell: false,
      };
    }
  }
  return undefined;
}

/**
 * Locate `binary` on `PATH` for the current platform.
 *
 * On Windows this returns the best shim (`.exe` > `.cmd`/`.bat` > `.ps1`) and
 * reports the arguments and `shell` flag needed to start it; elsewhere it is a
 * plain `PATH` walk. Exposed for the extension's "is pi installed?" probe.
 */
export function findOnPathBinary(binary: string, env: NodeJS.ProcessEnv = process.env): WinShim | undefined {
  if (process.platform === 'win32') {
    return findWindowsShim(binary, env);
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.length === 0) {
    return undefined;
  }
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, binary);
    if (isExecutableEntry(candidate)) {
      return { command: candidate, prefix: [], shell: false };
    }
  }
  return undefined;
}

export function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return findOnPathBinary(binary, env)?.command;
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
  // A Windows `.cmd`/`.bat` shim is a script, not the package, so the manifest is
  // not beside it. npm writes the real `node_modules` path inside the shim, so
  // follow that reference before walking ancestors.
  if (directory !== undefined && /\.(?:cmd|bat)$/i.test(entry)) {
    const referenced = packageDirFromShim(entry);
    if (referenced !== undefined) {
      directory = referenced;
    }
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

/**
 * The `node_modules` package directory a Windows `.cmd`/`.bat` shim points at.
 *
 * npm's shim is a script, so the manifest is not beside it: the file names the
 * real entry with something like
 *   `"%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"`.
 * Best effort — an unrecognised shim simply yields no version.
 */
function packageDirFromShim(entry: string): string | undefined {
  try {
    const text = readFileSync(entry, 'utf8');
    // npm shims reference the entry either absolutely (`C:\...`) or relative to
    // the shim's own directory via `%~dp0` / `%dp0%`.
    const match = /((?:[A-Za-z]:\\|(?:%~?dp0%?\\))[^"'\r\n]*?node_modules[\\/][^"'\r\n]+)/i.exec(text);
    if (match?.[1] === undefined) {
      return undefined;
    }
    const raw = match[1];
    const relative = raw.replace(/^(?:%~?dp0%?\\?)/i, '').replace(/\\/g, '/');
    const resolved = /^[A-Za-z]:[\\/]/.test(raw)
      ? raw.replace(/\\/g, '/')
      : join(dirname(entry), relative);
    let dir = dirname(resolved);
    for (let depth = 0; depth < 6 && dir !== dirname(dir); depth += 1) {
      if (existsSync(join(dir, 'package.json'))) {
        return dir;
      }
      dir = dirname(dir);
    }
  } catch {
    // Unreadable shim: no version, not an error.
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
