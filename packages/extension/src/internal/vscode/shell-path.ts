import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The `PATH` a login shell sees.
 *
 * VS Code started from the Dock/launcher does not source the user's profile, so
 * a `pi` installed through nvm, asdf, volta or fnm — all of which append to
 * `PATH` in `.zshrc`/`.bashrc` — is invisible to the extension host even though
 * it works in the integrated terminal. VS Code's own "shell environment
 * resolution" exists for this; running the login shell once is the small,
 * dependency-free version of it.
 *
 * Best effort: a shell that hangs, or one that does not print a PATH, leaves the
 * caller with the process PATH it already had.
 */
export async function loginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return windowsPath(env);
  }
  const shell = env.SHELL !== undefined && env.SHELL.trim().length > 0 ? env.SHELL.trim() : '/bin/bash';
  return new Promise((resolve) => {
    execFile(
      shell,
      // Log-in *and* interactive: nvm/asdf/volta are usually set up in `.zshrc`
      // or `.bashrc`, which a non-interactive shell never sources.
      ['-lic', 'printf "__MORSE_PATH__%s__MORSE_END__" "$PATH"'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(extractLoginPath(stdout));
      },
    );
  });
}

/**
 * The PATH additions a Windows login shell would have made, without a shell.
 *
 * `npm install -g` puts `pi.cmd`/`pi.ps1` in the npm prefix, which cmd.exe adds
 * to `PATH` but a VS Code started from the Start Menu or a service often does
 * not inherit. Node on Windows can be installed *anywhere* — `%USERPROFILE%\SDK`,
 * nvm-windows, fnm, volta, scoop, chocolatey, or an unusual drive — so a fixed
 * list of default prefixes is not enough. Instead, in order of trust:
 *
 * 1. The persistent `PATH` from the registry, which is what a fresh cmd.exe
 *    builds. This covers any custom location the user ever added.
 * 2. Directories named by version managers in the environment, which cover the
 *    common case where Node is on PATH only after a profile runs.
 * 3. The directory of the very `node` running this extension: the extension host
 *    usually *is* the user's Node, so its sibling bin holds the npm shims.
 * 4. The stock per-user and per-machine npm locations, as a last resort.
 *
 * Non-existent entries are harmless: `findOnPathBinary` only reports a real file.
 * Exported for the test.
 */
export function windowsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return windowsPathUnsafe(env);
  } catch {
    // Never let PATH enrichment stop the host from starting; an empty answer
    // just means the setup screen still reports pi as missing, as before.
    return undefined;
  }
}

function windowsPathUnsafe(env: NodeJS.ProcessEnv): string | undefined {
  const existing = env.PATH ?? env.Path ?? '';
  const separators = existing.length > 0 ? existing.split(';') : [];
  const seen = new Set(separators.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const additions: string[] = [];
  const add = (value: string | undefined): void => {
    if (value === undefined) {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    additions.push(trimmed);
  };

  for (const entry of windowsRegistryPath()) {
    add(entry);
  }
  for (const entry of windowsVersionManagerPath(env)) {
    add(entry);
  }
  for (const entry of windowsNodeSiblingPath()) {
    add(entry);
  }
  for (const entry of windowsDefaultNpmPath(env)) {
    add(entry);
  }

  if (additions.length === 0) {
    return existing.length > 0 ? existing : undefined;
  }
  return [existing, ...additions].filter((value) => value.length > 0).join(';');
}

/**
 * `%NVM_SYMLINK%`, `%VOLTA_HOME%\bin`, `%SCOOP%\shims` and friends. These are
 * set by the installers, and their targets are where the global shims land.
 * Unknown/missing variables contribute nothing.
 */
function windowsVersionManagerPath(env: NodeJS.ProcessEnv): Array<string | undefined> {
  return [
    env.NVM_SYMLINK,
    env.NVM_HOME,
    env.VOLTA_HOME !== undefined ? join(env.VOLTA_HOME, 'bin') : undefined,
    env.FNM_DIR !== undefined ? join(env.FNM_DIR, 'aliases') : undefined,
    env.SCOOP !== undefined ? join(env.SCOOP, 'shims') : undefined,
    env.SCOOP !== undefined ? join(env.SCOOP, 'apps', 'nodejs', 'current', 'bin') : undefined,
    env.ChocolateyInstall !== undefined ? join(env.ChocolateyInstall, 'bin') : undefined,
    env.NODE_HOME,
  ];
}

/**
 * `node`'s own directory and its parent's `npm` prefix, from the interpreter
 * running this extension. This is how a custom, `PATH`-less Node install is found
 * without guessing: the extension is already inside that Node.
 */
function windowsNodeSiblingPath(): string[] {
  const execDir = dirname(process.execPath);
  const prefix = dirname(execDir);
  return [
    execDir,
    join(prefix, 'npm'),
    // nvm-windows lays the global shims beside a `nodejs` symlink dir.
    join(dirname(prefix), 'npm'),
  ];
}

/** The stock npm global prefixes, for a Node installed the plain installer way. */
function windowsDefaultNpmPath(env: NodeJS.ProcessEnv): Array<string | undefined> {
  const home =
    env.USERPROFILE ??
    (env.HOMEDRIVE !== undefined && env.HOMEPATH !== undefined
      ? `${env.HOMEDRIVE}${env.HOMEPATH}`
      : homedir());
  return [
    env.APPDATA !== undefined ? join(env.APPDATA, 'npm') : undefined,
    home !== undefined && home.length > 0 ? join(home, 'AppData', 'Roaming', 'npm') : undefined,
    env.LOCALAPPDATA !== undefined ? join(env.LOCALAPPDATA, 'Programs', 'nodejs') : undefined,
    env.ProgramFiles !== undefined ? join(env.ProgramFiles, 'nodejs') : undefined,
    env['ProgramFiles(x86)'] !== undefined ? join(env['ProgramFiles(x86)'], 'nodejs') : undefined,
  ].filter((value): value is string => value !== undefined && value.length > 0);
}

/**
 * The persistent `PATH` under `HKCU\Environment` and the machine-wide
 * `...\Session Manager\Environment`, expanded from `REG_EXPAND_SZ`.
 *
 * This is the same source cmd.exe reads, so it is the one answer that covers an
 * arbitrary install location. Synchronous and best effort: a `reg.exe` miss or a
 * timeout yields `[]` and the other layers still run. `reg query` echoes the
 * value's name and type, e.g. `    Path    REG_EXPAND_SZ    C:\a;C:\b`.
 */
export function windowsRegistryPath(timeoutMs = 2_000): string[] {
  const keys = [
    ['HKCU\\Environment', 'Path'],
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'],
  ] as const;
  const results: string[] = [];
  for (const [key, name] of keys) {
    const raw = readRegistryValue(key, name, timeoutMs);
    if (raw === undefined) {
      continue;
    }
    const expanded = expandWindowsEnv(raw);
    for (const entry of expanded.split(';')) {
      if (entry.trim().length > 0) {
        results.push(entry.trim());
      }
    }
  }
  return results;
}

function readRegistryValue(key: string, name: string, timeoutMs: number): string | undefined {
  try {
    const output = execFileSyncSafe('reg', ['query', key, '/v', name], timeoutMs);
    // The value line is the one whose third column is the raw string.
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s{2,}(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.*)$/i.exec(line);
      if (match?.[1]?.trim().toLowerCase() === name.toLowerCase()) {
        return match[2]?.trim();
      }
    }
  } catch {
    // Key absent (common for HKLM on locked-down machines) or reg unavailable.
  }
  return undefined;
}

/** Expand `%VAR%` the way cmd.exe does, using the process environment. */
function expandWindowsEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()];
    return found !== undefined ? found : whole;
  });
}

function execFileSyncSafe(file: string, args: string[], timeoutMs: number): string {
  // A `reg.exe` miss throws and is handled by the caller; `windowsHide` keeps a
  // console window from flashing up under the extension host.
  return execFileSync(file, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
}

/**
 * The PATH between the sentinels, so a profile that prints a banner to stdout
 * cannot be mistaken for the PATH itself. Exported for the test.
 */
export function extractLoginPath(stdout: string): string | undefined {
  const match = /__MORSE_PATH__([\s\S]*?)__MORSE_END__/.exec(stdout);
  const path = match?.[1]?.trim();
  return path !== undefined && path.length > 0 ? path : undefined;
}
