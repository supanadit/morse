import { homedir } from 'node:os';
import {
  isPlainObject,
  resolveEngineContext,
  type ConfigFile,
  type ConfigMutation,
  type McpServer,
  type McpServerEntry,
} from '@morse/engine-config';
import type {
  McpConfigScope,
  McpMutation,
  McpServerInput,
  McpServerStatus,
  McpStatus,
} from '@morse/protocol';

import {
  OpenCodeEngineDefinition,
  type OpenCodeEngineInstance,
} from './engine/open-code-engine.js';
import type { OpenCodeMcpStore } from './engine/open-code-mcp-store.js';

/** What `status` is asked for; OpenCode's config has no live state to probe. */
export interface OpenCodeMcpStatusOptions {
  /** Ignored: OpenCode reports the configured state only, never a connection. */
  probe?: boolean;
}

/** The sentence the panel shows beside the list: a warm session keeps its servers. */
const NOTE =
  'OpenCode reports configured state only; a server connects when a session starts.';

/**
 * OpenCode's MCP administration: the `AgentMcpExtras` vocabulary over the
 * `mcp` key of `opencode.json`.
 *
 * OpenCode has no `mcp list` CLI, so the status is the config and nothing but
 * the config: a server reports whether it is enabled, never whether it is
 * connected. Servers are read when an OpenCode session starts, which the panel
 * says in its note — a warm session keeping its servers across an edit is the
 * engine's behavior, not a bug.
 *
 * Every call builds its own engine instance for the requested working
 * directory, so one manager can answer for any project the panel shows.
 */
export class OpenCodeMcp {
  private readonly definition: OpenCodeEngineDefinition;

  constructor(
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      /** Overrides the global config directory; tests inject a temp one. */
      configDir?: string;
      /**
       * Whose tree these files are: the reader's (`user`, the default) or one
       * Morse generated (`isolated`, a bot's). An isolated tree names its
       * `root` — the directory holding `opencode/` — and its files are private
       * from the moment they exist instead of keeping a 0644.
       */
      ownership?: 'user' | 'isolated';
      /** An isolated tree's root; ignored for a user tree. */
      root?: string;
    } = {},
  ) {
    this.definition = new OpenCodeEngineDefinition(
      options.configDir === undefined ? {} : { configDir: options.configDir },
    );
  }

  status(cwd?: string, _options: OpenCodeMcpStatusOptions = {}): McpStatus {
    const project = normalizeCwd(cwd);
    const list = this.store(project).list(project);
    return {
      servers: list.items.map(toServerStatus),
      errors: list.issues.map((issue) => issue.message),
      // OpenCode reads project configs without a trust decision.
      trusted: true,
      note: NOTE,
      issues: list.issues,
    };
  }

  add(input: McpServerInput, cwd?: string): McpMutation {
    const project = normalizeCwd(cwd);
    const server = toServer(input);
    if (typeof server === 'string') {
      return { ok: false, message: server };
    }
    const scope = input.scope ?? 'global';
    return withMessage(
      this.store(project).upsert(input.name, server, scope, project),
    );
  }

  remove(name: string, cwd?: string, scope?: McpConfigScope): McpMutation {
    const project = normalizeCwd(cwd);
    const target = scope ?? 'global';
    const store = this.store(project);
    // The panel has always named the file it looked in; the store words a
    // missing entry as a read-fallback refusal, which OpenCode has no concept of.
    const file = scopeFile(store, target, project);
    if (file !== undefined && definesIn(file, name, store.section.key) === false) {
      return notDefined(name, target, file.path);
    }
    return withMessage(store.remove(name, target, project));
  }

  setEnabled(
    name: string,
    enabled: boolean,
    cwd?: string,
    scope?: McpConfigScope,
  ): McpMutation {
    const project = normalizeCwd(cwd);
    // No scope named: the store edits the nearest definition, project first.
    return withMessage(this.store(project).setEnabled(name, enabled, scope, project));
  }

  /**
   * Rewrite a comment-bearing config as strict JSON, so the next mutation can
   * land. The host offers this as the Fix action beside a `normalize` issue.
   */
  fix(scope: McpConfigScope, cwd?: string): McpMutation {
    const project = normalizeCwd(cwd);
    return withMessage(this.store(project).normalize(scope, project));
  }

  /** OpenCode reads project configs untrusted, so there is nothing to write. */
  trustProject(_cwd: string): { ok: boolean } {
    return { ok: true };
  }

  /** A cheap fingerprint of the config files, for the host's change watcher. */
  async configSignature(cwd?: string): Promise<string> {
    const project = normalizeCwd(cwd);
    return this.store(project).signature(project);
  }

  /** The store for one call, resolved against the directory it is asked about. */
  private store(cwd: string | undefined): OpenCodeMcpStore {
    return this.instance(cwd).mcp;
  }

  private instance(cwd: string | undefined): OpenCodeEngineInstance {
    return this.definition.create(
      resolveEngineContext({
        ownership: this.options.ownership ?? 'user',
        home: homedir(),
        ...(cwd === undefined ? {} : { cwd }),
        env: this.options.env ?? process.env,
        ...(this.options.root === undefined ? {} : { root: this.options.root }),
      }),
    );
  }
}

/** One listed entry as the panel's row: configured, so disconnected at best. */
function toServerStatus(entry: McpServerEntry): McpServerStatus {
  const server = entry.server;
  const enabled = server.enabled !== false;
  return {
    name: server.name,
    scope: entry.scope,
    source: entry.source,
    enabled,
    transport: describeTransport(server),
    state: enabled ? 'disconnected' : 'disabled',
    tools: [],
  };
}

/** `stdio: command args` or `http: url`, the one-line summary the panel shows. */
function describeTransport(server: McpServer): string {
  if (server.type === 'http') {
    return `http: ${server.url ?? ''}`;
  }
  return `stdio: ${[server.command ?? '', ...(server.args ?? [])].join(' ')}`;
}

/** The neutral server an input describes, or the reason it cannot be stored. */
function toServer(input: McpServerInput): McpServer | string {
  const isRemote = input.url !== undefined && input.url.length > 0;
  const server: McpServer = { name: input.name, type: isRemote ? 'http' : 'stdio' };
  if (isRemote) {
    server.url = input.url!.trim();
    if (input.headers && Object.keys(input.headers).length > 0) {
      server.headers = input.headers;
    }
  } else {
    // OpenCode stores argv, not a command string; the codec re-joins them.
    const parts =
      (input.command ?? '').trim().length > 0
        ? [input.command!.trim(), ...(input.args ?? [])]
        : (input.args ?? []);
    if (parts.length === 0) {
      return 'A local server needs a "command".';
    }
    const [command, ...args] = parts;
    server.command = command!;
    if (args.length > 0) {
      server.args = args;
    }
    if (input.cwd?.trim()) {
      server.cwd = input.cwd.trim();
    }
    if (input.env && Object.keys(input.env).length > 0) {
      server.env = input.env;
    }
  }
  if (input.description?.trim()) {
    server.description = input.description.trim();
  }
  if (input.enabled === false) {
    server.enabled = false;
  }
  return server;
}

/**
 * The scope's write target, or `undefined` when the scope cannot be resolved
 * without a project directory: the mutation itself then reports why.
 */
function scopeFile(
  store: OpenCodeMcpStore,
  scope: McpConfigScope,
  cwd: string | undefined,
): ConfigFile | undefined {
  try {
    return store.file(scope, cwd);
  } catch {
    return undefined;
  }
}

/**
 * Whether this file defines `name`. `undefined` when it could not be read or
 * parsed: the mutation then carries the real complaint, and a "not defined"
 * sentence would hide it.
 */
function definesIn(file: ConfigFile, name: string, key: string): boolean | undefined {
  const document = file.read();
  if (document.issues.length > 0) {
    return undefined;
  }
  const root = document.value;
  const block = isPlainObject(root) ? root[key] : undefined;
  return isPlainObject(block) && Object.hasOwn(block, name);
}

/** The refusal the panel has always shown for a name a file does not define. */
function notDefined(name: string, scope: McpConfigScope, path: string): McpMutation {
  return {
    ok: false,
    path,
    scope,
    message:
      scope === 'project'
        ? `"${name}" is not defined in this project's opencode.json.`
        : `"${name}" is not defined in the global opencode.json.`,
  };
}

/**
 * A failed mutation always says why: the store reports issues, and the panel
 * shows `message`, so the first issue becomes the sentence when the store did
 * not write one (a refused JSONC write is the common case).
 */
function withMessage(mutation: ConfigMutation): McpMutation {
  if (mutation.ok) {
    return mutation;
  }
  const message = mutation.message ?? mutation.issues?.[0]?.message;
  return message === undefined ? mutation : { ...mutation, message };
}

function normalizeCwd(cwd?: string): string | undefined {
  return cwd !== undefined && cwd.length > 0 ? cwd : undefined;
}
