import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UpdateHostResult } from '@morse/protocol';
import type { MorseLogger } from '@morse/core';

const run = promisify(execFile);

/** The package the browser host is published as; the only thing this can update. */
export const MORSE_PACKAGE = '@supanadit/morse-web';

/**
 * The module directory, one level under the package root in both the monorepo
 * (`packages/server/dist/internal/self-update/…`) and the published bundle
 * (`<pkg>/dist/…`). `packageRoot` walks up until it finds a `package.json` whose
 * `name` is this package, so the version it reports is the one actually running.
 */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * The version of the Morse package that is running, read from the nearest
 * `package.json` above this module. Unlike the frontend manifest (which names the
 * *frontend* bundle), this is the host package itself — the number `npm install -g`
 * would replace.
 */
export function runningVersion(startDir = moduleDir()): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        // In the monorepo the nearest package.json is `@morse/server`, so keep
        // walking: the published artifact is the one whose name is the npm package.
        if (parsed.name === MORSE_PACKAGE && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        /* an unreadable package.json is not the one we want */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Whether this host may update itself at all. The checks are deliberately blunt,
 * and all of them must hold:
 *
 * - `MORSE_SELF_UPDATE=1` opted in — the browser UI is unauthenticated, so a
 *   self-update endpoint must never appear by accident.
 * - We are not the VS Code host (which updates through the Marketplace).
 * - The running module lives under an npm global prefix this user can write to;
 *   otherwise `npm install -g` would fail (or need root) after the user already
 *   confirmed, which is worse than refusing up front.
 */
export async function canSelfUpdate(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isOn(env.MORSE_SELF_UPDATE)) {
    return false;
  }
  try {
    const { stdout } = await run('npm', ['prefix', '-g'], { timeout: 10_000 });
    const prefix = stdout.trim();
    if (prefix.length === 0) return false;
    // The published bundle is loaded from <prefix>/lib/node_modules/@supanadit/morse-web,
    // so a running module that is not under the prefix is a dev tree or a VSIX:
    // replacing it with a global install would shadow the wrong copy.
    const here = moduleDir();
    return here.startsWith(prefix);
  } catch {
    return false;
  }
}

function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Where the CLI entry that can relaunch this host lives, from the running module. */
export function cliEntry(startDir = moduleDir()): string | undefined {
  // In the published package the CLI sits beside the bundled server
  // (`dist/cli.mjs`, `dist/server.mjs`). The server is bundled, so the source
  // module path is not reliable; resolve against the package root instead.
  let dir = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (parsed.name === MORSE_PACKAGE) {
          const cli = join(dir, 'dist', 'cli.mjs');
          return existsSync(cli) ? cli : undefined;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface SelfUpdateOptions {
  /** Where the helper and its log live: the Morse data directory. */
  dataDir: string;
  /** The version the host is serving, for the result. */
  currentVersion: string;
  /** Injected for tests; the real helper spawns node. */
  spawn?: (command: string, args: string[], options: { detached: boolean; stdio: 'ignore' }) => void;
  /** Injected for tests; the real helper exits the process. */
  exit?: (code: number) => void;
  /** How long to let the reply flush before exiting; tests shorten it. */
  exitDelayMs?: number;
  logger?: MorseLogger;
}

/**
 * The `updateHost` command: install the latest published build in a detached
 * helper and let it relaunch the host.
 *
 * It never installs in-process. `npm install -g` rewrites the very files this
 * process is running from, and the re-exec has to happen *after* npm exits — so a
 * small detached Node program owns the whole sequence: it waits for this daemon to
 * die, installs, and runs `morse start` again (the same CLI the user ran, which
 * re-reads the state file and binds the same port).
 *
 * The reply is sent before the exit so the frontend can say "updating, reloading"
 * instead of watching the socket drop.
 */
export async function performSelfUpdate(options: SelfUpdateOptions): Promise<UpdateHostResult> {
  const { currentVersion } = options;
  const cli = cliEntry();
  if (cli === undefined) {
    return {
      ok: false,
      from: currentVersion,
      message: 'This host cannot restart itself (no morse CLI beside the server bundle). Run npm install -g @supanadit/morse-web@latest and restart it yourself.',
    };
  }

  const helper = join(options.dataDir, 'self-update.mjs');
  const spawn = options.spawn ?? defaultSpawn;
  const exit = options.exit ?? gracefulExit;

  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(options.dataDir, { recursive: true });
    writeFileSync(helper, helperSource(options.dataDir), 'utf8');
  } catch (error) {
    options.logger?.error('Failed to stage the self-update helper', error);
    return {
      ok: false,
      from: currentVersion,
      message: 'Could not stage the update helper. Run npm install -g @supanadit/morse-web@latest yourself.',
    };
  }

  try {
    // Detached and quiet: the helper must outlive this process and has no
    // terminal of its own. Its own log file is how a failure is read back.
    spawn(process.execPath, [helper, cli, String(process.pid)], {
      detached: true,
      stdio: 'ignore',
    });
  } catch (error) {
    options.logger?.error('Failed to spawn the self-update helper', error);
    return {
      ok: false,
      from: currentVersion,
      message: 'Could not start the updater. Run npm install -g @supanadit/morse-web@latest yourself.',
    };
  }

  // Give the reply a moment to reach the socket before the process goes away.
  // The caller emits the result, then this resolves; the CLI/helper does the rest.
  options.logger?.info(`Self-update started by PID ${process.pid}; the host will relaunch.`);
  const timer = setTimeout(() => exit(0), options.exitDelayMs ?? 250);
  timer.unref?.();

  return {
    ok: true,
    from: currentVersion,
    restarting: true,
    message: `Installing the latest Morse and restarting. The page will reload when the new build is up.`,
  };
}

/**
 * End the process so a supervisor can run the new build. A plain `process.exit`
 * would skip NestJS's shutdown hooks and orphan every live `pi` process, so this
 * asks the process to terminate (the same SIGTERM the CLI's `stop` sends) and only
 * forces exit if the graceful path stalls. The OS releases the port either way;
 * the detached helper waits for this pid before it installs and restarts.
 */
function gracefulExit(code: number): void {
  const forced = setTimeout(() => process.exit(code), 5_000);
  forced.unref?.();
  try {
    process.kill(process.pid, 'SIGTERM');
  } catch {
    process.exit(code);
  }
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
): void {
  const child = spawn(command, args, options);
  child.unref();
}

/**
 * The detached program. It is written to disk rather than passed with `-e`
 * because a quoted one-liner is fragile across shells and platforms, and because
 * the daemon log can name the file when something goes wrong.
 *
 * Sequence: wait for the old daemon to exit (so the port is free and the files it
 * mapped are gone), install the latest build globally, then run `morse start`
 * again with the same CLI the user originally ran.
 */
export function helperSource(dataDir: string): string {
  return `// Generated by Morse's self-update. Safe to delete.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [cli, oldPid] = process.argv.slice(2);
const logFile = join(${JSON.stringify(dataDir)}, 'self-update.log');
const log = (line) => {
  try {
    appendFileSync(logFile, \`[\${new Date().toISOString()}] \${line}\\n\`);
  } catch {
    /* logging is best-effort */
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(Number(pid), 0);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      log(\`\${command} failed to start: \${error.message}\`);
      resolve(1);
    });
  });
}

const main = async () => {
  log('waiting for the Morse daemon to exit');
  await waitForExit(oldPid, 30_000);
  log('installing the latest @supanadit/morse-web');
  const installed = await run('npm', ['install', '-g', '@supanadit/morse-web@latest']);
  if (installed !== 0) {
    log('npm install failed; leaving the running host alone');
    return;
  }
  log('starting the new build');
  await run(process.execPath, [cli, 'start']);
  log('done');
};

void main();
`;
}
