import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  definesMcpServer,
  findMcpServer,
  isValidMcpServerName,
  removeMcpServer,
  setMcpServerEnabled,
  setMcpServerOverrideEnabled,
  upsertMcpServer,
  type McpConfigScope,
  type McpFileExposure,
  type McpFileServer,
} from './internal/mcp-config.js';
import { resolvePiCli } from './internal/resolve-pi.js';
import { readProjectTrust, writeProjectTrust, type TrustResult } from './internal/project-trust.js';
import { cleanSpawnEnv } from './internal/spawn-env.js';

/** How a server reaches the model (pi's `McpExposure`). */
export type McpExposure = McpFileExposure;

/** pi's connection lifecycle, plus the entry that is configured but turned off. */
export type McpServerState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs-auth'
  | 'failed'
  | 'closed'
  | 'disabled';

export type McpServerScope = 'global' | 'project' | 'extension';

/** Where a mutation edits: the user file or this project's `.pi/mcp.json`. */
export type { McpConfigScope };

/** One server, as `pi mcp list --json` reports it. */
export interface McpServerStatus {
  name: string;
  scope: McpServerScope;
  /** The `mcp.json` that defines it (or the extension path). */
  source: string;
  enabled: boolean;
  exposure: McpExposure;
  /** A one-line summary of how it connects: `stdio: command args` or `http: url`. */
  transport: string;
  state: McpServerState;
  /** The tool names the server offers once connected. */
  tools: string[];
  /**
   * The project `.pi/mcp.json` that overrides a user-level server's
   * `enabled`/`exposure` for this directory. Present only when there is one.
   */
  override?: string;
  /** Per-tool exposure overrides, when they differ from the server's. */
  toolExposure?: Record<string, McpExposure>;
  resources?: number;
  resourceTemplates?: number;
  /** Why it is not connected: the connection error, or the config-file complaint. */
  error?: string;
}

/** What `mcpStatus` answers. `errors` are config-file problems pi could not attach to a server. */
export interface McpStatus {
  servers: McpServerStatus[];
  errors: string[];
  note?: string;
  /**
   * Whether pi would load this project's `.pi` resources. False means the
   * project files (including `.pi/mcp.json`) are ignored until it is trusted.
   */
  trusted?: boolean;
}

/** What `mcpAdd` takes. Exactly one of `command` (stdio) or `url` (http) is required. */
export interface McpServerInput {
  name: string;
  /** `project` writes `<cwd>/.pi/mcp.json`; default `global` (`~/.pi/agent/mcp.json`). */
  scope?: 'global' | 'project';
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  exposure?: McpExposure;
  description?: string;
}

/** What a mutation answers. `message` carries the reason when it refused. */
export interface McpMutation {
  ok: boolean;
  message?: string;
  /** The `mcp.json` that was written, for the panel to name. */
  path?: string;
  /** Which file the change landed in. */
  scope?: McpConfigScope;
  /** True when a user-level server got a project override instead of a rewrite. */
  override?: boolean;
}

/**
 * Rebuild an `McpServerInput` from a wire payload, dropping anything of the
 * wrong shape. Every host parses the panel's `mcpAdd` arguments through this, so
 * the validation lives in one place.
 */
export function parseMcpServerInput(raw: unknown): McpServerInput {
  const args = isRecord(raw) ? raw : {};
  const input: McpServerInput = { name: asString(args.name) };
  if (args.scope === 'global' || args.scope === 'project') {
    input.scope = args.scope;
  }
  if (args.type === 'stdio' || args.type === 'http') {
    input.type = args.type;
  }
  for (const key of ['command', 'cwd', 'url', 'description'] as const) {
    const value = asString(args[key]);
    if (value.length > 0) {
      input[key] = value;
    }
  }
  if (args.exposure === 'codemode' || args.exposure === 'deferred' || args.exposure === 'direct' || args.exposure === 'hidden') {
    input.exposure = args.exposure;
  }
  if (Array.isArray(args.args)) {
    input.args = args.args.filter(isString);
  }
  input.env = stringRecord(args.env);
  input.headers = stringRecord(args.headers);
  return input;
}

export interface PiMcpOptions {
  piPath?: string;
  nodeEntryPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the agent directory; defaults to `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
  agentDir?: string;
  /** How long `pi mcp list` may take before it is killed. */
  timeoutMs?: number;
}

/** `pi mcp list` connects every enabled server, so it is not instant. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Driven adapter for pi's MCP configuration: list server state through the CLI,
 * and add, remove or toggle servers by editing the same `mcp.json` pi reads.
 *
 * A session's MCP servers are scoped to its working directory (project
 * `.pi/mcp.json` next to the user-level file), so every method takes the `cwd`
 * of the session it is asked about.
 */
export class PiMcp {
  constructor(private readonly options: PiMcpOptions = {}) {}

  /** Connect every enabled server and report what happened. */
  async status(cwd: string): Promise<McpStatus> {
    const spawn = resolvePiCli(this.options);
    const { stdout, stderr, failed, timedOut } = await run(
      spawn.command,
      [...spawn.baseArgs, 'mcp', 'list', '--json'],
      cwd,
      cleanSpawnEnv(this.env()),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const parsed = parseStatus(stdout);
    if (!parsed) {
      const seconds = Math.round((this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
      const detail = timedOut
        ? `\`pi mcp list\` did not finish within ${seconds}s — a server is likely hanging (try \`pi mcp list\` in a terminal)`
        : stderr.trim() || (failed ? `\`pi mcp list\` exited with an error` : 'no output');
      throw new Error(`Could not read the MCP server list: ${detail}`);
    }
    return { ...parsed, trusted: readProjectTrust(cwd, this.agentDir()) };
  }

  /**
   * Marks the session's project trusted, so pi loads the project's `.pi`
   * resources (mcp.json included). pi's plain "Trust", not a parent folder.
   */
  trustProject(cwd: string): TrustResult {
    return writeProjectTrust(cwd, this.agentDir());
  }

  async add(input: McpServerInput, cwd: string): Promise<McpMutation> {
    if (!isValidMcpServerName(input.name)) {
      return {
        ok: false,
        message: `"${input.name}" is not a valid server name (letters, digits, "_" and "-").`,
      };
    }
    const isHttp = input.type === 'http' || (input.url !== undefined && input.command === undefined);
    const config = this.toConfig(input, isHttp);
    if (typeof config === 'string') {
      return { ok: false, message: config };
    }
    const path = this.configPath(cwd, input.scope);
    try {
      upsertMcpServer(path, input.name, config);
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    return { ok: true, path };
  }

  async remove(name: string, cwd: string, scope?: McpConfigScope): Promise<McpMutation> {
    if (scope === 'global') {
      return this.removeFrom(this.globalPath(), name, 'global');
    }
    if (scope === 'project') {
      return this.removeFrom(this.projectPath(cwd), name, 'project');
    }
    // No scope named: the defining file first (a project definition wins), then
    // the user file — the behaviour before the editor exposed a scope.
    for (const path of this.configPaths(cwd)) {
      try {
        if (removeMcpServer(path, name)) {
          return { ok: true, path };
        }
      } catch (error: unknown) {
        return { ok: false, message: describe(error) };
      }
    }
    return { ok: false, message: `No server named "${name}" is configured.` };
  }

  private removeFrom(path: string, name: string, scope: McpConfigScope): McpMutation {
    try {
      if (!removeMcpServer(path, name)) {
        return {
          ok: false,
          message:
            scope === 'project'
              ? `"${name}" is not defined in this project's .pi/mcp.json.`
              : `"${name}" is not defined in the user mcp.json.`,
        };
      }
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    return { ok: true, path, scope };
  }

  /**
   * Enable or disable a server in one scope.
   *
   * Global edits the user file. Project edits the project entry when the project
   * defines the server, and otherwise writes a project **override** — the way
   * pi's `/mcp` does "Disable in this project" — so a user-level server can be
   * turned off in one directory without touching every other project.
   */
  async setEnabled(
    name: string,
    enabled: boolean,
    cwd: string,
    scope?: McpConfigScope,
  ): Promise<McpMutation> {
    if (scope === 'global') {
      return this.setEnabledIn(this.globalPath(), name, enabled, 'global');
    }
    if (scope === 'project') {
      const projectPath = this.projectPath(cwd);
      if (definesMcpServer(findMcpServer(projectPath, name))) {
        return this.setEnabledIn(projectPath, name, enabled, 'project');
      }
      // A user-level server (or an existing project override): write the
      // override rather than the defining file.
      const known =
        findMcpServer(projectPath, name) !== undefined ||
        findMcpServer(this.globalPath(), name) !== undefined;
      if (!known) {
        return {
          ok: false,
          message: `No server named "${name}" is configured.`,
        };
      }
      try {
        setMcpServerOverrideEnabled(projectPath, name, enabled);
      } catch (error: unknown) {
        return { ok: false, message: describe(error) };
      }
      return { ok: true, path: projectPath, scope: 'project', override: true };
    }
    // No scope named: the defining file first (project, then global).
    for (const path of this.configPaths(cwd)) {
      try {
        if (findMcpServer(path, name) === undefined) {
          continue;
        }
        setMcpServerEnabled(path, name, enabled);
        return { ok: true, path };
      } catch (error: unknown) {
        return { ok: false, message: describe(error) };
      }
    }
    return { ok: false, message: `No server named "${name}" is configured.` };
  }

  private setEnabledIn(
    path: string,
    name: string,
    enabled: boolean,
    scope: McpConfigScope,
  ): McpMutation {
    try {
      if (findMcpServer(path, name) === undefined) {
        return {
          ok: false,
          message:
            scope === 'project'
              ? `"${name}" is not defined in this project's .pi/mcp.json.`
              : `"${name}" is not defined in the user mcp.json.`,
        };
      }
      setMcpServerEnabled(path, name, enabled);
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    return { ok: true, path, scope };
  }

  /** The user-level file first, then the project's — so a project definition wins. */
  private configPaths(cwd: string): string[] {
    return [this.projectPath(cwd), this.globalPath()];
  }

  private configPath(cwd: string, scope: 'global' | 'project' | undefined): string {
    return scope === 'project' ? this.projectPath(cwd) : this.globalPath();
  }

  private globalPath(): string {
    return join(this.agentDir(), 'mcp.json');
  }

  private projectPath(cwd: string): string {
    return join(cwd, '.pi', 'mcp.json');
  }

  private agentDir(): string {
    if (this.options.agentDir) {
      return this.options.agentDir;
    }
    const fromEnv = this.env().PI_CODING_AGENT_DIR;
    return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.pi', 'agent');
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  /** The stored entry, or an error message when the input is incomplete. */
  private toConfig(input: McpServerInput, isHttp: boolean): McpFileServer | string {
    const config: McpFileServer = {};
    if (isHttp) {
      const url = input.url?.trim();
      if (!url) {
        return 'An HTTP server needs a "url".';
      }
      config.type = 'http';
      config.url = url;
      if (input.headers && Object.keys(input.headers).length > 0) {
        config.headers = input.headers;
      }
    } else {
      const command = input.command?.trim();
      if (!command) {
        return 'A stdio server needs a "command".';
      }
      config.type = 'stdio';
      config.command = command;
      if (input.args && input.args.length > 0) {
        config.args = input.args;
      }
      if (input.cwd?.trim()) {
        config.cwd = input.cwd.trim();
      }
      if (input.env && Object.keys(input.env).length > 0) {
        config.env = input.env;
      }
    }
    if (input.exposure && input.exposure !== 'codemode') {
      config.exposure = input.exposure;
    }
    if (input.description?.trim()) {
      config.description = input.description.trim();
    }
    if (input.enabled === false) {
      config.enabled = false;
    }
    return config;
  }
}

interface CliResult {
  stdout: string;
  stderr: string;
  failed: boolean;
  /** `execFile`'s timeout killed it (as opposed to the CLI choosing to exit non-zero). */
  timedOut: boolean;
}

/**
 * Run the CLI and always resolve, even on a non-zero exit: `pi mcp list --json`
 * prints the full report to stdout and then exits 1 when a server is not
 * connected, which is exactly the answer Morse wants.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const code = err?.code;
        if (typeof code === 'string') {
          // A spawn failure (ENOENT/EACCES), not an exit status.
          reject(new Error(`Could not run "${command}": ${stderr.trim() || code}`));
          return;
        }
        resolve({ stdout, stderr, failed: error !== null, timedOut: err?.killed === true });
      },
    );
  });
}

function parseStatus(stdout: string): McpStatus | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<McpStatus>;
    if (!Array.isArray(parsed.servers)) {
      return undefined;
    }
    return {
      servers: parsed.servers.map(toServerStatus),
      errors: Array.isArray(parsed.errors) ? parsed.errors.filter(isString) : [],
      ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Normalise one row. The CLI's shape is stable, but the panel must not crash on a surprising one. */
function toServerStatus(raw: unknown): McpServerStatus {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const scope = row.scope;
  return {
    name: isString(row.name) ? row.name : 'unknown',
    scope: scope === 'project' || scope === 'extension' ? scope : 'global',
    source: isString(row.source) ? row.source : '',
    ...(isString(row.override) ? { override: row.override } : {}),
    enabled: row.enabled !== false,
    exposure: toExposure(row.exposure),
    transport: isString(row.transport) ? row.transport : '',
    state: toState(row.state),
    tools: Array.isArray(row.tools) ? row.tools.filter(isString) : [],
    ...(isRecord(row.toolExposure) ? { toolExposure: toExposureMap(row.toolExposure) } : {}),
    ...(typeof row.resources === 'number' ? { resources: row.resources } : {}),
    ...(typeof row.resourceTemplates === 'number'
      ? { resourceTemplates: row.resourceTemplates }
      : {}),
    ...(isString(row.error) ? { error: row.error } : {}),
  };
}

function toState(value: unknown): McpServerState {
  switch (value) {
    case 'connecting':
    case 'connected':
    case 'disconnected':
    case 'needs-auth':
    case 'failed':
    case 'closed':
    case 'disabled':
      return value;
    default:
      return 'failed';
  }
}

function toExposure(value: unknown): McpExposure {
  switch (value) {
    case 'codemode':
    case 'deferred':
    case 'direct':
    case 'hidden':
      return value;
    default:
      return 'codemode';
  }
}

function toExposureMap(value: Record<string, unknown>): Record<string, McpExposure> {
  const result: Record<string, McpExposure> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toExposure(entry);
  }
  return result;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
