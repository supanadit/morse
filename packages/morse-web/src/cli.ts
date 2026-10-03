/**
 * `morse` — lifecycle CLI for the standalone browser host.
 *
 * This file owns only the *process* concerns: daemonize, pidfile, log file,
 * health probe and the `stop`/`restart`/`status`/`logs` commands. Everything
 * protocol- and agent-shaped lives in `dist/server.mjs`, which is the same
 * NestJS composition root used in development — the CLI never reimplements it.
 *
 *   morse start        # daemonize, print the URL, exit — the terminal may close
 *   morse start -f     # stay in the foreground (systemd Type=simple)
 *   morse status|stop|restart|logs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(CLI_DIR, '..');
const SERVER_ENTRY = join(CLI_DIR, 'server.mjs');
const UI_DIR = join(CLI_DIR, 'ui');
const PACKAGE_JSON = join(PACKAGE_ROOT, 'package.json');

/** Data directory: state, logs and (by default) nothing else. */
const MORSE_HOME = process.env.MORSE_HOME?.trim() || join(homedir(), '.morse');
const STATE_FILE = join(MORSE_HOME, 'server.json');
const LOG_DIR = join(MORSE_HOME, 'logs');
const LOG_FILE = join(LOG_DIR, 'server.log');

const DEFAULT_PORT = 4399;
const DEFAULT_HOST = '127.0.0.1';
const HEALTH_PATH = '/api/health';

interface ServerState {
  pid: number;
  port: number;
  host: string;
  url: string;
  workspace: string;
  startedAt: string;
  logFile: string;
}

interface Options {
  command: string;
  port?: number;
  host?: string;
  workspace?: string;
  projects?: string;
  lan: boolean;
  foreground: boolean;
  open: boolean;
  follow: boolean;
  force: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

// --- tiny terminal helpers (no dependencies) ---------------------------------

const colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: number) => (text: string) =>
  colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = paint(2);
const bold = paint(1);
const cyan = paint(36);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);

// --- argument parsing --------------------------------------------------------

const COMMANDS = new Set([
  'start',
  'serve',
  'stop',
  'restart',
  'status',
  'logs',
  'help',
  'version',
]);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'start',
    lan: false,
    foreground: false,
    open: false,
    follow: false,
    force: false,
    json: false,
    help: false,
    version: false,
  };
  let commandSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = splitFlag(arg);
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case 'start':
      case 'serve':
      case 'stop':
      case 'restart':
      case 'status':
      case 'logs':
      case 'help':
      case 'version':
        options.command = flag;
        commandSeen = true;
        break;
      case '-p':
      case '--port':
        options.port = parsePort(takeValue(), flag);
        break;
      case '--host':
      case '--hostname':
        options.host = takeValue();
        break;
      case '--workspace':
      case '--cwd':
        options.workspace = takeValue();
        break;
      case '--projects':
        options.projects = takeValue();
        break;
      case '--lan':
        options.lan = true;
        break;
      case '-f':
      case '--foreground':
      case '--no-daemon':
        options.foreground = true;
        break;
      case '--open':
        options.open = true;
        break;
      case '--follow':
        options.follow = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        if (!arg.startsWith('-') && !commandSeen) {
          options.command = arg;
          commandSeen = true;
          break;
        }
        throw new Error(`Unknown option "${arg}". Run \`morse help\`.`);
    }
  }

  if (!COMMANDS.has(options.command)) {
    throw new Error(`Unknown command "${options.command}". Run \`morse help\`.`);
  }
  return options;
}

function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith('--')) return [arg, undefined];
  const equals = arg.indexOf('=');
  return equals === -1 ? [arg, undefined] : [arg.slice(0, equals), arg.slice(equals + 1)];
}

function parsePort(value: string, flag: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} expects a port between 1 and 65535`);
  }
  return port;
}

// --- state file --------------------------------------------------------------

function readState(): ServerState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<ServerState>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return undefined;
    return {
      pid: parsed.pid,
      port: parsed.port,
      host: parsed.host ?? DEFAULT_HOST,
      url: parsed.url ?? `http://${DEFAULT_HOST}:${parsed.port}/`,
      workspace: parsed.workspace ?? process.cwd(),
      startedAt: parsed.startedAt ?? new Date().toISOString(),
      logFile: parsed.logFile ?? LOG_FILE,
    };
  } catch {
    return undefined;
  }
}

function writeState(state: ServerState): void {
  mkdirSync(MORSE_HOME, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function clearState(): void {
  rmSync(STATE_FILE, { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// --- networking --------------------------------------------------------------

function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? DEFAULT_HOST : host;
}

function healthUrl(state: Pick<ServerState, 'host' | 'port'>): string {
  return `http://${displayHost(state.host)}:${state.port}${HEALTH_PATH}`;
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe(url)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, DEFAULT_HOST);
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${start}..${start + 99}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// --- commands ----------------------------------------------------------------

async function start(options: Options): Promise<number> {
  const existing = readState();
  if (existing && isAlive(existing.pid)) {
    if (!options.force) {
      console.log(`${yellow('Morse is already running')} (PID ${existing.pid})`);
      console.log(`  visit: ${cyan(existing.url)}`);
      console.log(`  stop:  ${dim(`morse stop`)}`);
      return 0;
    }
    await stop({ quiet: true });
  }
  clearState();

  const workspace = options.workspace ? resolve(options.workspace) : process.cwd();
  if (!existsSync(workspace)) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  const envPort = process.env.MORSE_PORT ? Number.parseInt(process.env.MORSE_PORT, 10) : NaN;
  let port = options.port ?? (Number.isInteger(envPort) ? envPort : undefined) ?? DEFAULT_PORT;
  if (options.port === undefined && !Number.isInteger(envPort)) {
    // Nobody asked for a specific port: avoid clobbering whatever already
    // listens on the default one (another Morse, a dev server, ...).
    port = await findFreePort(DEFAULT_PORT);
  } else if (!(await isPortFree(port))) {
    throw new Error(`Port ${port} is already in use. Pass --port to pick another one.`);
  }

  const host = options.lan ? '0.0.0.0' : (options.host ?? process.env.MORSE_HOST ?? DEFAULT_HOST);
  const env = buildEnv(options, port, host, workspace);

  if (options.foreground) {
    return startForeground(env, port, host, workspace);
  }
  return startDaemon(env, port, host, workspace, options);
}

function buildEnv(options: Options, port: number, host: string, workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MORSE_HOST: host,
    MORSE_PORT: String(port),
    MORSE_UI_DIR: UI_DIR,
    MORSE_WORKSPACE: workspace,
  };
  if (options.projects) env.MORSE_PROJECTS = options.projects;
  return env;
}

async function startDaemon(
  env: NodeJS.ProcessEnv,
  port: number,
  host: string,
  workspace: string,
  options: Options,
): Promise<number> {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(
    LOG_FILE,
    `\n=== morse start ${new Date().toISOString()} (port ${port}) ===\n`,
    { flag: 'a' },
  );
  const logFd = openSync(LOG_FILE, 'a');

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: workspace,
    env,
    detached: true,
    // The daemon owns no terminal: closing the shell must not send it SIGHUP.
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const state: ServerState = {
    pid: child.pid ?? -1,
    port,
    host,
    url: `http://${displayHost(host)}:${port}/`,
    workspace,
    startedAt: new Date().toISOString(),
    logFile: LOG_FILE,
  };
  writeState(state);

  const healthy = await waitForHealth(healthUrl(state), 25_000);
  if (!healthy) {
    console.error(red('Morse failed to start.'));
    if (!isAlive(state.pid)) {
      clearState();
      console.error(dim(`Last lines of ${LOG_FILE}:`));
      console.error(tailLog(40));
      return 1;
    }
    console.error(dim('The process is alive but did not answer the health probe.'));
    console.error(dim(`Logs: morse logs`));
    return 1;
  }

  console.log();
  console.log(`  ${green('▲')}  ${bold('Morse started')}`);
  console.log(`  │`);
  console.log(`  ◆  port ${port} (PID: ${state.pid})`);
  console.log(`  │`);
  console.log(`  ●  visit: ${cyan(state.url)}`);
  console.log(`  ●  logs:  ${dim('morse logs')}`);
  console.log(`  │`);
  console.log(`  └  daemon running — the terminal can be closed`);
  console.log();

  if (options.open) openBrowser(state.url);
  return 0;
}

async function startForeground(
  env: NodeJS.ProcessEnv,
  port: number,
  host: string,
  workspace: string,
): Promise<number> {
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: workspace, env, stdio: 'inherit' });
  writeState({
    pid: child.pid ?? -1,
    port,
    host,
    url: `http://${displayHost(host)}:${port}/`,
    workspace,
    startedAt: new Date().toISOString(),
    logFile: LOG_FILE,
  });

  const forward = (signal: NodeJS.Signals): void => {
    if (child.pid !== undefined) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  const code = await new Promise<number>((resolveExit) => {
    child.on('exit', (exitCode) => resolveExit(exitCode ?? 0));
  });
  clearState();
  return code;
}

async function stop(options: { quiet?: boolean } = {}): Promise<number> {
  const state = readState();
  if (!state || !isAlive(state.pid)) {
    clearState();
    if (!options.quiet) console.log(dim('Morse is not running.'));
    return 0;
  }

  const { pid } = state;
  process.kill(pid, 'SIGTERM');
  if (!(await waitForExit(pid, 5000))) {
    process.kill(pid, 'SIGKILL');
    await waitForExit(pid, 2000);
  }
  clearState();
  if (!options.quiet) {
    console.log(`${green('●')} Morse stopped (PID ${pid}).`);
  }
  return 0;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

function status(options: Options): number {
  const state = readState();
  if (!state || !isAlive(state.pid)) {
    clearState();
    if (options.json) {
      console.log(JSON.stringify({ running: false }));
    } else {
      console.log(dim('Morse is not running.'));
    }
    return 1;
  }

  const uptimeMs = Date.now() - new Date(state.startedAt).getTime();
  if (options.json) {
    console.log(JSON.stringify({ running: true, ...state, uptimeMs }));
    return 0;
  }
  console.log(`${green('●')} Morse is running (PID ${state.pid})`);
  console.log(`  visit:     ${cyan(state.url)}`);
  console.log(`  workspace: ${state.workspace}`);
  console.log(`  uptime:    ${formatUptime(uptimeMs)}`);
  console.log(`  logs:      ${dim(state.logFile)}`);
  return 0;
}

function formatUptime(uptimeMs: number): string {
  const seconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function tailLog(linesToShow: number): string {
  if (!existsSync(LOG_FILE)) return '(no log yet)';
  const lines = readFileSync(LOG_FILE, 'utf8').split('\n');
  return lines.slice(-linesToShow).join('\n');
}

async function logs(options: Options): Promise<number> {
  if (!existsSync(LOG_FILE)) {
    console.log(dim(`No log file yet (${LOG_FILE}).`));
    return 0;
  }
  process.stdout.write(tailLog(200));
  if (!options.follow) return 0;

  // Simple, dependency-free `tail -f` so it works the same on every platform.
  let seen = readFileSync(LOG_FILE, 'utf8').length;
  await new Promise<void>((resolveFollow) => {
    const timer = setInterval(() => {
      try {
        const current = readFileSync(LOG_FILE, 'utf8');
        if (current.length > seen) {
          process.stdout.write(current.slice(seen));
          seen = current.length;
        } else if (current.length < seen) {
          seen = current.length;
        }
      } catch {
        /* the log was rotated away; keep waiting */
      }
    }, 400);
    const stopFollowing = (): void => {
      clearInterval(timer);
      resolveFollow();
    };
    process.on('SIGINT', stopFollowing);
    process.on('SIGTERM', stopFollowing);
  });
  return 0;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* opening a browser is best-effort */
  }
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  const name = `@supanadit/morse-web`;
  console.log(`
 ${bold('Morse')} — the Comfortable Pi Interface, in your browser (${name})

 ${bold('USAGE')}
   morse [COMMAND] [OPTIONS]

 ${bold('COMMANDS')}
   start            Start the web server in the background (default)
   stop             Stop the running server
   restart          Stop, then start the server
   status           Show whether the server is running
   logs             Print the server log (--follow to tail)
   help             Show this help
   version          Print the version

 ${bold('OPTIONS')}
   -p, --port <n>       Web server port (default: ${DEFAULT_PORT}, next free if taken)
   --host <addr>        Bind address (default: ${DEFAULT_HOST})
   --lan                Bind 0.0.0.0 so the LAN can reach it
   -f, --foreground     Run in the foreground (systemd Type=simple)
   --workspace <dir>    Directory the agent works in (default: the current one)
   --projects <list>    Comma/colon separated list of roots the agent may open
   --open               Open the browser once the server is healthy
   --force              Replace a server this CLI already started
   --json               Machine-readable output (status)
   --follow             Follow the log file (logs)
   -h, --help           Show this help
   -v, --version        Print the version

 ${bold('ENVIRONMENT')}
   MORSE_HOME             Data directory (default: ~/.morse)
   MORSE_PORT             Default port
   MORSE_HOST             Default bind address
   MORSE_WORKSPACE        Workspace the agent runs in
   MORSE_PROJECTS         Roots the agent may open
   MORSE_HOT_SESSIONS     How many pi processes stay alive (default: 4)
   MORSE_PI_PATH          Path to the pi executable (default: pi on PATH)
   MORSE_PI_ENTRY         Run a pi RPC entry with node instead of the binary

 ${bold('EXAMPLES')}
   morse                          # start the daemon on ${DEFAULT_PORT}
   morse start --port 8080        # a specific port
   morse --lan --port 3002        # reachable on the LAN
   morse start --open             # start and open the browser
   morse logs --follow            # tail the server log
   morse stop                     # stop the daemon
`);
}

// --- entry point -------------------------------------------------------------

export async function run(argv: string[]): Promise<number> {
  const options = parseArgs(argv);

  if (options.version || options.command === 'version') {
    console.log(readVersion());
    return 0;
  }
  if (options.help || options.command === 'help') {
    printHelp();
    return 0;
  }

  switch (options.command) {
    case 'start':
    case 'serve':
      return start(options);
    case 'stop':
      return stop();
    case 'restart':
      await stop({ quiet: true });
      return start(options);
    case 'status':
      return status(options);
    case 'logs':
      return logs(options);
    default:
      printHelp();
      return 0;
  }
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('morse:')} ${message}`);
    process.exitCode = 1;
  });
