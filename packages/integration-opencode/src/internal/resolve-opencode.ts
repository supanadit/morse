import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * Finds the OpenCode binary, and says how to start it.
 *
 * Auto-detection is why a host that has OpenCode installed can offer it with no
 * configuration, while a pi-only machine pays nothing: no binary and no
 * configured URL means the engine is never constructed, so no server is started.
 *
 * The check is a PATH walk (plus the Windows shim extensions), mirroring how the
 * pi adapter resolves its binary; an explicit path is validated the same way so a
 * typo fails at registration with the path the user wrote, not later at spawn.
 *
 * Windows needs more than a file path. `npm install -g @opencode/cli` leaves an
 * `opencode.cmd` shim there, and Node refuses to start a `.cmd` without `cmd.exe`
 * (`spawn` throws EINVAL), so a host that found the binary and then ran it
 * reported OpenCode as missing. The shim is therefore read: it names the program
 * it stands for, and that program is started directly — the same treatment the
 * pi adapter gives `pi.cmd`, which also keeps Morse's own `stop()` pointed at the
 * server rather than at a `cmd.exe` wrapper that would outlive it.
 */

/**
 * How to start OpenCode: the program, and the arguments that select it before
 * any subcommand. A Windows shim becomes either the program hidden inside it or
 * `cmd.exe` running the shim, so a caller only ever spawns `command` + `prefix`.
 */
export interface OpenCodeSpawn {
  /** The program to run: `opencode` itself, or `node`/`powershell`/`cmd.exe`. */
  command: string;
  /** Arguments that select OpenCode, to go before the subcommand (`serve`). */
  prefix: string[];
}

/** One install found on disk, plus how to start it. */
export interface OpenCodeInstall {
  /** The file that was found: the binary, or the shim that stands for it. */
  file: string;
  spawn: OpenCodeSpawn;
}

/** Where the binary is, or `undefined` when this machine has none. */
export function findOpenCodeBinary(
  binary = 'opencode',
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return locate(binary, env)?.file;
}

/**
 * How to start the binary, or `undefined` when this machine has none. This is
 * what a host spawns; `findOpenCodeBinary` is only the "is it installed?" answer.
 */
export function resolveOpenCodeSpawn(
  binary = 'opencode',
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeSpawn | undefined {
  return locate(binary, env)?.spawn;
}

function locate(binary: string, env: NodeJS.ProcessEnv): OpenCodeInstall | undefined {
  const name = binary.trim();
  if (name.length === 0) {
    return undefined;
  }
  const windows = process.platform === 'win32';
  // An explicit path may itself contain a separator; treat it as the answer.
  if (name.includes('/') || name.includes('\\')) {
    return startable(name, windows);
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.length === 0) {
    return undefined;
  }
  if (windows) {
    return findWindowsInstall(name, env);
  }
  // `path.delimiter` is `:` off Windows, which is the only place this runs.
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const install = startable(join(directory, name), false);
    if (install !== undefined) {
      return install;
    }
  }
  return undefined;
}

/**
 * The Windows PATH walk, exported so it can be tested anywhere: `process.platform`
 * cannot be faked, and the suite runs on Linux.
 *
 * Extensions come from `PATHEXT`, which is a shell variable and is often absent
 * from a GUI process, and are probed in that order inside each directory — the
 * way `cmd.exe` resolves a bare name, so a real `.exe` wins over a `.cmd` beside
 * it. `.ps1` is never in `PATHEXT` and is probed last, only when nothing better
 * exists: its execution policy can block it and it costs a `powershell` process.
 */
export function findWindowsInstall(
  binary: string,
  env: NodeJS.ProcessEnv,
): OpenCodeInstall | undefined {
  const directories = (env.PATH ?? env.Path ?? '').split(';').filter((entry) => entry.length > 0);
  for (const directory of directories) {
    for (const extension of windowsExtensions(env)) {
      const install = startable(join(directory, `${binary}${extension}`), true);
      if (install !== undefined) {
        return install;
      }
    }
  }
  for (const directory of directories) {
    const install = startable(join(directory, `${binary}.ps1`), true);
    if (install !== undefined) {
      return install;
    }
  }
  return undefined;
}

/** `PATHEXT` is a shell variable and is often absent from GUI processes. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * How to start one file, or `undefined` when this platform cannot start it.
 *
 * Windows has no executable bit, so existence is the whole answer there and the
 * extension picks the treatment: `.exe`/`.com` run as-is, `.cmd`/`.bat` are read
 * for the program they wrap, `.ps1` needs powershell. A file with no extension is
 * the POSIX sh script npm writes beside the shims — Windows cannot run it.
 */
function startable(file: string, windows: boolean): OpenCodeInstall | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  if (!windows) {
    return isExecutable(file) ? { file, spawn: { command: file, prefix: [] } } : undefined;
  }
  const lowered = file.toLowerCase();
  if (lowered.endsWith('.ps1')) {
    return {
      file,
      spawn: {
        command: 'powershell.exe',
        prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      },
    };
  }
  if (lowered.endsWith('.cmd') || lowered.endsWith('.bat')) {
    // A shim that cannot be read is still startable, just through cmd.exe — the
    // wrapper a `.cmd` is, with the console window that comes with it.
    return {
      file,
      spawn: unwrapShim(file) ?? {
        command: 'cmd.exe',
        prefix: ['/d', '/s', '/c', file],
      },
    };
  }
  if (/\.[^.\\/]+$/.test(lowered)) {
    return { file, spawn: { command: file, prefix: [] } };
  }
  return undefined;
}

/**
 * The program an npm-generated `.cmd`/`.bat` shim runs, started directly.
 *
 * Starting the shim means starting `cmd.exe`, which briefly flashes a console
 * window that `windowsHide` cannot suppress, and which leaves the real process as
 * a grandchild that a kill on the wrapper does not reach. The shim itself names
 * what it runs, in the forms npm and hand-written shims use:
 *
 * ```bat
 * "%dp0%\node_modules\@opencode\cli\bin\opencode.exe"   %*
 * "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
 * "%~dp0fake-opencode.js" %*
 * ```
 *
 * so the target is the last quoted `%dp0%`/`%~dp0` path on a line that forwards
 * arguments (`%*`) — `IF EXIST ...` and `SET ...` lines are not invocations. A
 * `.js` runs on node (the one beside the shim when npm ships it there); anything
 * else is an executable image and runs as-is. `undefined` when the body is
 * unreadable or names something else, and the caller falls back to `cmd.exe`.
 */
function unwrapShim(shim: string): OpenCodeSpawn | undefined {
  let content: string;
  try {
    content = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }
  const base = dirname(shim);
  const batchDir = /%~dp0|%dp0%/i;
  let target: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('%*')) {
      continue;
    }
    for (const match of line.matchAll(/"([^"]*(?:%~dp0|%dp0%)[^"]*)"/gi)) {
      const relative = match[1]!.split(batchDir).pop() ?? '';
      const resolved = join(base, relative.replace(/^[\\/]+/, ''));
      if (isProgram(resolved)) {
        target = resolved;
      }
    }
  }
  if (target === undefined) {
    return undefined;
  }
  if (/\.(?:c|m)?js$/i.test(target)) {
    const localNode = join(base, 'node.exe');
    return {
      command: existsSync(localNode) ? localNode : process.execPath,
      prefix: [target],
    };
  }
  return { command: target, prefix: [] };
}

/** A path a shim can point at: a real script or a real executable image. */
function isProgram(path: string): boolean {
  return existsSync(path) && /\.(?:exe|com|(?:c|m)?js)$/i.test(path);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
