import type {
  McpConfigScope,
  McpMutation,
  McpServerInput,
  McpServerStatus,
  McpStatus,
} from '@morse/protocol';
import {
  configSignature,
  effectiveServers,
  openCodeConfigPaths,
  readOpenCodeFile,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
  type OpenCodeMcpServer,
} from './internal/opencode-mcp-config.js';

/**
 * OpenCode's MCP administration: the `AgentMcpExtras` vocabulary over the
 * `mcp` key of `opencode.json`.
 *
 * OpenCode has no `mcp list` CLI, so the status is the config and nothing but
 * the config: a server reports whether it is enabled, never whether it is
 * connected. Servers are read when an OpenCode session starts, which the panel
 * says in its note — a warm session keeping its servers across an edit is the
 * engine's behavior, not a bug.
 */
export class OpenCodeMcp {
  constructor(
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      /** Overrides the global config directory; tests inject a temp one. */
      configDir?: string;
    } = {},
  ) {}

  status(cwd?: string): McpStatus {
    const paths = openCodeConfigPaths(normalizeCwd(cwd), this.options.configDir);
    const errors: string[] = [];
    // A malformed file must not hide the other scope's servers: read each file
    // separately and report what could not be parsed.
    const servers: McpServerStatus[] = [];
    try {
      for (const { name, server, source } of effectiveServers(paths)) {
        const global = source === paths[paths.length - 1];
        servers.push({
          name,
          scope: global ? 'global' : 'project',
          source,
          enabled: server.enabled !== false,
          transport: transportOf(server),
          state: server.enabled === false ? 'disabled' : 'disconnected',
          tools: [],
        });
      }
    } catch (error: unknown) {
      errors.push(describe(error));
    }
    return {
      servers,
      errors,
      // OpenCode reads project configs without a trust decision.
      trusted: true,
      note: 'OpenCode reports configured state only; a server connects when a session starts.',
    };
  }

  add(input: McpServerInput, cwd?: string): McpMutation {
    const isRemote = input.url !== undefined && input.url.length > 0;
    const server: OpenCodeMcpServer = { type: isRemote ? 'remote' : 'local' };
    if (isRemote) {
      server.url = input.url!.trim();
      if (input.headers && Object.keys(input.headers).length > 0) {
        server.headers = input.headers;
      }
    } else {
      // OpenCode stores argv, not a command string.
      const parts = (input.command ?? '').trim().length > 0
        ? [input.command!.trim(), ...(input.args ?? [])]
        : (input.args ?? []);
      if (parts.length === 0) {
        return { ok: false, message: 'A local server needs a "command".' };
      }
      server.command = parts;
      if (input.cwd?.trim()) {
        server.cwd = input.cwd.trim();
      }
      if (input.env && Object.keys(input.env).length > 0) {
        server.environment = input.env;
      }
    }
    if (input.enabled === false) {
      server.enabled = false;
    }
    const path = this.pathFor(input.scope, cwd);
    try {
      upsertMcpServer(path, input.name, server);
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    return { ok: true, path, scope: input.scope ?? 'global' };
  }

  remove(name: string, cwd?: string, scope?: string): McpMutation {
    const path = this.pathFor(scope as McpConfigScope | undefined, cwd);
    try {
      if (!removeMcpServer(path, name)) {
        return {
          ok: false,
          message:
            scope === 'project'
              ? `"${name}" is not defined in this project's opencode.json.`
              : `"${name}" is not defined in the global opencode.json.`,
        };
      }
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
    return { ok: true, path, scope: (scope as McpConfigScope) ?? 'global' };
  }

  setEnabled(name: string, enabled: boolean, cwd?: string, scope?: string): McpMutation {
    const forced = scope as McpConfigScope | undefined;
    try {
      if (forced !== undefined) {
        const path = this.pathFor(forced, cwd);
        if (!setMcpServerEnabled(path, name, enabled)) {
          return {
            ok: false,
            message:
              forced === 'project'
                ? `"${name}" is not defined in this project's opencode.json.`
                : `"${name}" is not defined in the global opencode.json.`,
          };
        }
        return { ok: true, path, scope: forced };
      }
      // No scope named: the defining file first (project, then global).
      for (const path of openCodeConfigPaths(normalizeCwd(cwd), this.options.configDir)) {
        if (readOpenCodeFile(path).mcp?.[name] === undefined) {
          continue;
        }
        setMcpServerEnabled(path, name, enabled);
        return { ok: true, path };
      }
      return { ok: false, message: `No server named "${name}" is configured.` };
    } catch (error: unknown) {
      return { ok: false, message: describe(error) };
    }
  }

  /** OpenCode reads project configs untrusted, so there is nothing to write. */
  trustProject(_cwd: string): { ok: boolean } {
    return { ok: true };
  }

  /** A cheap fingerprint of the config files, for the host's change watcher. */
  async configSignature(cwd?: string): Promise<string> {
    return configSignature(openCodeConfigPaths(normalizeCwd(cwd), this.options.configDir));
  }

  /** The file an edit lands in: the named scope's, else the global one. */
  private pathFor(scope: McpConfigScope | undefined, cwd?: string): string {
    const paths = openCodeConfigPaths(normalizeCwd(cwd), this.options.configDir);
    return scope === 'project' && paths.length > 1 ? paths[0] : paths[paths.length - 1];
  }
}

function transportOf(server: OpenCodeMcpServer): string {
  return server.type === 'remote'
    ? `http: ${server.url ?? ''}`
    : `stdio: ${(server.command ?? []).join(' ')}`;
}

function normalizeCwd(cwd?: string): string | undefined {
  return cwd !== undefined && cwd.length > 0 ? cwd : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
