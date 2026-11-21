import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isValidMcpServerName,
  resolveEngineContext,
  type ConfigIssue,
  type ConfigMutation,
  type ConfigScope,
  type McpServer,
  type McpServerEntry,
  normalizeCwd,
  messageOf,
} from '@morse/engine-config';

import { isRecord } from './internal/rpc/helpers.js';
import { PiEngineDefinition, type PiEngineInstance } from './engine/pi-engine.js';
import type { PiMcpStore } from './engine/pi-mcp-store.js';
import {
  McpInspector,
  type McpInspectOptions,
  type McpInspection,
  type McpServerSpec,
} from './internal/mcp-client.js';
import { readProjectTrust, writeProjectTrust, type TrustResult } from './internal/project-trust.js';
import type {
  McpConfigScope,
  McpExposure,
  McpServerScope,
  McpServerState,
  McpServerStatus,
  McpStatus,
} from '@morse/protocol';

// pi's rows are the wire vocabulary, not a second copy of it: one definition
// means a field the manager reports cannot be missing from the shape the panel
// reads back. Re-exported so callers of this module keep their imports.
export type {
  McpConfigScope,
  McpExposure,
  McpServerScope,
  McpServerState,
  McpServerStatus,
  McpStatus,
};

/** Options for `status`: leave `probe` off to answer from the files alone. */
export interface McpStatusOptions {
  /** Connect each enabled, trusted server and fill in its live state. */
  probe?: boolean;
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
  /** Config-file complaints the mutation collected while reading or writing. */
  issues?: ConfigIssue[];
}

/** The slice of `McpInspector` a status probe uses; tests inject a fake. */
export interface McpProbe {
  inspect(spec: McpServerSpec, options: McpInspectOptions): Promise<McpInspection>;
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
  /**
   * Retained for compatibility with the CLI-backed manager. Listing now reads
   * pi's files directly, so nothing resolves or spawns the binary.
   */
  piPath?: string;
  /** Retained for compatibility; see `piPath`. */
  nodeEntryPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the agent directory; defaults to `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
  agentDir?: string;
  /** Retained for compatibility; probes use `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * The whole probe's budget across every enabled server, so a panel with many
   * servers still answers inside the frontend's status timeout. Defaults to
   * `PROBE_BUDGET_MS`; `0` disables the cap.
   */
  probeBudgetMs?: number;
  /** The prober; defaults to a real `McpInspector`. Tests inject a fake. */
  inspector?: McpProbe;
}

/** A probe never takes longer than this; a hung server must not hang the list. */
const PROBE_TIMEOUT_MS = 10_000;
/** A panel with many servers still opens promptly when probes run three at a time. */
const PROBE_CONCURRENCY = 3;
/**
 * The whole probe is capped too: the frontend gives `mcpStatus` 30 s, and a
 * dozen servers at 10 s each would exceed it even three at a time. Rows the
 * budget does not reach stay `disconnected` with the reason on the row.
 */
const PROBE_BUDGET_MS = 25_000;

/**
 * Driven adapter for pi's MCP configuration: list the servers pi's own files
 * declare, and add, remove or toggle them by editing the same `mcp.json` pi
 * reads. The list never shells out to `pi mcp list`; a probe is what fills in
 * live connection state.
 *
 * A session's MCP servers are scoped to its working directory (project
 * `.pi/mcp.json` next to the user-level file), so every method takes the `cwd`
 * of the session it is asked about.
 */
export class PiMcp {
  private readonly definition = new PiEngineDefinition();
  private readonly inspector: McpProbe;

  constructor(private readonly options: PiMcpOptions = {}) {
    this.inspector = options.inspector ?? new McpInspector();
  }

  /** List the configured servers, optionally connecting each enabled one.
   *
   * `cwd` is the session's project. Omitted means **global only**: the store
   * reads just the agent directory's `mcp.json`, and no trust state is reported
   * (there is no project to trust). That is what lets the MCP panel work from
   * the empty-session view for the user's own servers.
   */
  async status(cwd?: string, options: McpStatusOptions = {}): Promise<McpStatus> {
    const project = normalizeCwd(cwd);
    const trusted = project === undefined ? undefined : readProjectTrust(project, this.agentDir());
    // An untrusted project contributes nothing: pi would ignore its `.pi` tree,
    // so its overrides must not tune a global row, turn one on for a probe, or
    // add its parse/name complaints. Read the global chain alone instead.
    const scopeCwd = trusted === false ? undefined : project;
    const store = this.store(scopeCwd);
    const list = store.list(scopeCwd);
    const entries = list.items;
    const servers = entries.map(toServerStatus);
    const byName = new Map(entries.map((entry) => [entry.server.name, entry]));

    if (options.probe === true) {
      const enabled = servers.filter((server) => server.enabled);
      const settled = new Set<string>();
      // Flipped by the budget timer itself, before the awaiting code resumes, so
      // a probe that lands afterwards cannot overwrite the expiry it lost to.
      let expired = false;
      const work = eachLimited(enabled, PROBE_CONCURRENCY, async (server) => {
        if (expired) {
          return;
        }
        const entry = byName.get(server.name);
        if (entry === undefined) {
          return;
        }
        try {
          const outcome = await this.probe(entry, project);
          if (expired) {
            return;
          }
          server.state = outcome.state;
          if (outcome.tools !== undefined) {
            server.tools = outcome.tools;
          }
          if (outcome.resources !== undefined) {
            server.resources = outcome.resources;
          }
          if (outcome.resourceTemplates !== undefined) {
            server.resourceTemplates = outcome.resourceTemplates;
          }
          if (outcome.error !== undefined) {
            // A refusal belongs to this row. It is not a config-file complaint,
            // so it must not reach `issues` where the panel offers Fix.
            server.error = outcome.error;
          }
          settled.add(server.name);
        } catch (error: unknown) {
          if (expired) {
            return;
          }
          // A worker must never reject the whole list; this row carries it.
          server.state = 'failed';
          server.error = messageOf(error);
          settled.add(server.name);
        }
      });
      const timedOut = await withBudget(work, this.probeBudgetMs(), () => {
        expired = true;
      });
      if (timedOut) {
        for (const server of enabled) {
          if (settled.has(server.name)) {
            continue;
          }
          // Not reached, or still dialing when the budget ran out: an honest
          // "we could not check this one" instead of a spinner that never ends.
          server.state = 'disconnected';
          server.error = `The probe budget expired before this server was checked.`;
        }
      }
    }

    // Only the files' own complaints: a probe failure is the row's problem.
    const issues = list.issues;
    const errors = issues.map((issue) => issue.message);
    return {
      servers,
      errors,
      issues,
      note:
        'This list comes from the configured files only; a probe fills in live connection state.',
      ...(trusted === undefined ? {} : { trusted }),
    };
  }

  /**
   * Marks the session's project trusted, so pi loads the project's `.pi`
   * resources (mcp.json included). pi's plain "Trust", not a parent folder.
   */
  trustProject(cwd: string): TrustResult {
    return writeProjectTrust(cwd, this.agentDir());
  }

  /**
   * Rewrite one of pi's config files as strict JSON, so a later write can land.
   *
   * The file is named by the `ConfigIssue` the panel shows, and only a path this
   * manager resolves for `fileId`/`scope`/`cwd` is touched: a fix repairs pi's
   * own config, it never normalises an arbitrary file. pi has one fixable file
   * id today (`mcp`); anything else is refused as unsupported.
   */
  fix(request: {
    fileId: string;
    path: string;
    scope: ConfigScope;
    cwd?: string;
  }): ConfigMutation {
    const project = normalizeCwd(request.cwd);
    if (request.fileId !== 'mcp') {
      return fixRefusal(request, `pi has no fixable config file "${request.fileId}".`);
    }
    try {
      const instance = this.instance(project);
      const paths = instance.paths(request.fileId, request.scope, project);
      if (request.path !== paths.write && !paths.read.includes(request.path)) {
        return fixRefusal(
          request,
          `"${request.path}" is not one of pi's ${request.scope} config paths.`,
        );
      }
      return instance.fileAt(request.fileId, request.path, request.scope).normalize();
    } catch (error: unknown) {
      return fixRefusal(request, messageOf(error));
    }
  }

  async add(input: McpServerInput, cwd?: string): Promise<McpMutation> {
    if (!isValidMcpServerName(input.name)) {
      return {
        ok: false,
        message: `"${input.name}" is not a valid server name (letters, digits, "_" and "-").`,
      };
    }
    const project = normalizeCwd(cwd);
    if (input.scope === 'project' && project === undefined) {
      return { ok: false, message: 'Open a session to add a server to its project.' };
    }
    const isHttp = input.type === 'http' || (input.url !== undefined && input.command === undefined);
    const server = this.toConfig(input, isHttp);
    if (typeof server === 'string') {
      return { ok: false, message: server };
    }
    const store = this.store(project);
    const scope = input.scope ?? 'global';
    return store.upsert(input.name, server, scope, project);
  }

  /**
   * Remove a server. With no scope named, the entry the chain lists decides:
   * a project definition is removed before a user-level one.
   */
  async remove(name: string, cwd?: string, scope?: McpConfigScope): Promise<McpMutation> {
    const project = normalizeCwd(cwd);
    if (scope === 'project' && project === undefined) {
      return { ok: false, message: "Open a session to edit this project's MCP servers." };
    }
    const store = this.store(project);
    if (scope !== undefined) {
      return store.remove(name, scope, project);
    }
    const entry = store.list(project).items.find((item) => item.server.name === name);
    if (entry === undefined) {
      return { ok: false, message: `No server named "${name}" is configured.` };
    }
    // A project override is the nearer edit: the pre-store manager removed the
    // project's pin first, leaving the user-level definition in place.
    return store.remove(name, entry.override === undefined ? entry.scope : 'project', project);
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
    cwd?: string,
    scope?: McpConfigScope,
  ): Promise<McpMutation> {
    const project = normalizeCwd(cwd);
    if (scope === 'project' && project === undefined) {
      return { ok: false, message: "Open a session to edit this project's MCP servers." };
    }
    const store = this.store(project);
    if (scope === undefined) {
      // With no scope the nearer edit is the project's pin, exactly as the
      // pre-store manager toggled the entry in the project file first.
      const entry = store.list(project).items.find((item) => item.server.name === name);
      if (entry?.override !== undefined) {
        return store.setEnabled(name, enabled, 'project', project);
      }
    }
    return store.setEnabled(name, enabled, scope, project);
  }

  /**
   * A fingerprint of the `mcp.json` files that decide this directory's servers:
   * the project file when there is one, then the user-wide one. Cheap enough to
   * poll, and it moves whenever a server is added, removed, toggled or
   * hand-edited — which is what an external watcher needs.
   */
  async configSignature(cwd?: string): Promise<string> {
    const project = normalizeCwd(cwd);
    return this.store(project).signature(project);
  }

  /**
   * The store for one call. A set `agentDir` is an isolated root for a
   * global-only list; with a project it names pi's user tree instead, so the
   * project `.pi/mcp.json` still takes precedence.
   */
  private store(cwd: string | undefined): PiMcpStore {
    return this.instance(cwd).mcp;
  }

  private instance(cwd: string | undefined): PiEngineInstance {
    const env = this.env();
    const agentDir = this.configuredAgentDir();
    if (agentDir !== undefined) {
      if (cwd === undefined) {
        return this.definition.isolated(agentDir, {
          env,
          home: homedir(),
        }) as PiEngineInstance;
      }
      return this.definition.create(
        resolveEngineContext({
          ownership: 'user',
          home: homedir(),
          cwd,
          env: { ...env, PI_CODING_AGENT_DIR: agentDir },
        }),
      );
    }
    return this.definition.create(
      resolveEngineContext({
        ownership: 'user',
        home: homedir(),
        ...(cwd === undefined ? {} : { cwd }),
        env,
      }),
    );
  }

  /** Connect one server and translate the inspection into a status patch. */
  private async probe(entry: McpServerEntry, project: string | undefined): Promise<ProbeOutcome> {
    try {
      // Building the spec is inside the guard too: a malformed row must not be
      // able to reject the whole list.
      const spec = toSpec(entry.server);
      const cwd = spec.cwd ?? project ?? this.agentDir();
      const result = await withTimeout(
        this.inspector.inspect(spec, { cwd, env: this.env(), timeoutMs: PROBE_TIMEOUT_MS }),
        PROBE_TIMEOUT_MS,
      );
      if (result.ok) {
        return {
          state: 'connected',
          tools: result.tools.map((tool) => tool.name),
          resources: result.resources.length,
          resourceTemplates: result.resourceTemplates.length,
        };
      }
      const kind = result.error?.kind;
      return {
        state: kind === 'auth' ? 'needs-auth' : kind === 'timeout' ? 'disconnected' : 'failed',
        error: result.error?.message ?? 'The probe failed.',
      };
    } catch (error: unknown) {
      // Only our budget expiring is a disconnect; a thrown probe is a failure.
      return {
        state: error instanceof ProbeTimeoutError ? 'disconnected' : 'failed',
        error: messageOf(error),
      };
    }
  }

  /** A set agent dir, or `undefined` for the environment/default fallback. */
  private configuredAgentDir(): string | undefined {
    const value = this.options.agentDir;
    return value !== undefined && value.length > 0 ? value : undefined;
  }

  private agentDir(): string {
    const configured = this.configuredAgentDir();
    if (configured !== undefined) {
      return configured;
    }
    const fromEnv = this.env().PI_CODING_AGENT_DIR;
    return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.pi', 'agent');
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  /** The whole probe's budget; `0` (or less) means "no cap". */
  private probeBudgetMs(): number {
    return this.options.probeBudgetMs ?? PROBE_BUDGET_MS;
  }

  /** The stored entry, or an error message when the input is incomplete. */
  private toConfig(input: McpServerInput, isHttp: boolean): McpServer | string {
    const server: McpServer = { name: input.name, type: isHttp ? 'http' : 'stdio' };
    if (isHttp) {
      const url = input.url?.trim();
      if (!url) {
        return 'An HTTP server needs a "url".';
      }
      server.url = url;
      if (input.headers && Object.keys(input.headers).length > 0) {
        server.headers = input.headers;
      }
    } else {
      const command = input.command?.trim();
      if (!command) {
        return 'A stdio server needs a "command".';
      }
      server.command = command;
      if (input.args && input.args.length > 0) {
        server.args = input.args;
      }
      if (input.cwd?.trim()) {
        server.cwd = input.cwd.trim();
      }
      if (input.env && Object.keys(input.env).length > 0) {
        server.env = input.env;
      }
    }
    if (input.exposure && input.exposure !== 'codemode') {
      server.exposure = input.exposure;
    }
    if (input.description?.trim()) {
      server.description = input.description.trim();
    }
    if (input.enabled === false) {
      server.enabled = false;
    }
    return server;
  }
}

/** Our own probe budget expired; distinct from a server-side timeout result. */
class ProbeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeTimeoutError';
  }
}

/** A fix refused before any write: the panel shows the sentence beside the file. */
function fixRefusal(
  request: { fileId: string; path: string; scope: ConfigScope },
  message: string,
): ConfigMutation {
  return {
    ok: false,
    message,
    path: request.path,
    scope: request.scope,
    issues: [
      {
        file: request.path,
        fileId: request.fileId,
        scope: request.scope,
        code: 'unsupported',
        message,
        fixable: false,
      },
    ],
  };
}

/** A probe's result, as the fields a status row carries. */
interface ProbeOutcome {
  state: McpServerState;
  tools?: string[];
  resources?: number;
  resourceTemplates?: number;
  error?: string;
}

/** One listed entry as the panel's row. State is filled by a probe, when asked. */
function toServerStatus(entry: McpServerEntry): McpServerStatus {
  const server = entry.server;
  const enabled = server.enabled !== false;
  return {
    name: server.name,
    scope: entry.scope,
    source: entry.source,
    ...(entry.override === undefined ? {} : { override: entry.override }),
    enabled,
    exposure: server.exposure ?? 'codemode',
    transport: describeTransport(server),
    state: enabled ? 'connecting' : 'disabled',
    tools: [],
    // The entry itself, so the editor can open it without a second read.
    config: server,
  };
}

/** `stdio: command args` or `http: url`, the one-line summary the panel shows. */
function describeTransport(server: McpServer): string {
  if (server.type === 'http') {
    return `http: ${server.url ?? ''}`.trimEnd();
  }
  return `stdio: ${[server.command ?? '', ...(server.args ?? [])].join(' ')}`.trimEnd();
}

/** The neutral server as an inspector spec, dropping keys it does not take. */
function toSpec(server: McpServer): McpServerSpec {
  const spec: McpServerSpec = { type: server.type };
  if (server.command !== undefined) spec.command = server.command;
  if (server.args !== undefined) spec.args = server.args;
  if (server.cwd !== undefined) spec.cwd = server.cwd;
  if (server.env !== undefined) spec.env = server.env;
  if (server.url !== undefined) spec.url = server.url;
  if (server.headers !== undefined) spec.headers = server.headers;
  return spec;
}

/** Run an async worker over items with at most `limit` in flight. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      await worker(items[index] as T);
    }
  });
  // All settled: one worker's mistake is that row's problem, never the list's.
  await Promise.allSettled(runners);
}

/**
 * Await `work`, but stop waiting once the whole-probe budget passes. Returns
 * `true` when the budget won and called `onExpire` (so in-flight work can see it
 * and stop writing rows); a `budgetMs` of zero or less means no cap at all.
 */
async function withBudget(
  work: Promise<void>,
  budgetMs: number,
  onExpire: () => void,
): Promise<boolean> {
  if (budgetMs <= 0) {
    await work;
    return false;
  }
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      onExpire();
      resolve(true);
    }, budgetMs);
  });
  // `work` already settles every worker; this only makes the type explicit.
  const settled = work.then(
    () => false,
    () => false,
  );
  try {
    return await Promise.race([settled, budget]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Reject once the budget passes, even when the promise never settles. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ProbeTimeoutError(
          `The probe did not finish within ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
