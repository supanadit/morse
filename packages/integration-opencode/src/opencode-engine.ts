import {
  SessionEngine,
  type AgentEventListener,
  type AgentGateway,
  type AgentGatewayFactory,
  type AgentHistoryPage,
  type AgentSessionInfo,
  type AgentSessionState,
  type ModelRef,
  type WorkspaceRef,
} from '@morse/agent';
import {
  UnsupportedByHostError,
  type AgentExtras,
  type AgentIntegration,
  type MorseLogger,
} from '@morse/system';
import type { McpConfigScope, McpServerInput } from '@morse/protocol';
import { OpenCodeMcp, type OpenCodeMcpStatusOptions } from './opencode-mcp.js';
import { OpenCodePrompts } from './opencode-prompts.js';
import {
  connectOpenCode,
  type OpenCodeConnection,
  type OpenCodeConnectionOptions,
} from './internal/connection.js';
import { OpenCodeApi } from './internal/client.js';
import { OpenCodeEventStream } from './internal/event-stream.js';
import { defaultModeId, readAgentCatalog, readDefaultModel } from './internal/catalog.js';
import { OpenCodeConfigGuard } from './internal/config-guard.js';
import {
  thinkingLevelOf,
  thinkingLevelsOf,
  toModelRef,
  toModelRefs,
  type ApiModel,
} from './internal/model-mapping.js';
import { OpenCodeAgent, readAvailableCommands } from './opencode-agent.js';
import { OpenCodeSessionCatalog } from './opencode-session-catalog.js';
import { resolveOpenCodeSpawn } from './internal/resolve-opencode.js';

/**
 * OpenCode as a `SessionEngine`: the kind, the factory, the catalog, and the
 * lifetime of the server Morse may have started.
 *
 * The engine is one per host. Its connection is either a server the user runs
 * (attached, never stopped) or a private one Morse spawned (owned, stopped on
 * dispose), and the event stream is shared by every session — which is the whole
 * shape difference from pi's process-per-session adapter.
 */

/** The pieces a host can inject; production builds them in `createOpenCodeEngine`. */
export interface OpenCodeEngineDeps {
  connection: Pick<OpenCodeConnection, 'baseUrl' | 'password' | 'owned' | 'close'>;
  api: OpenCodeApi;
  stream: OpenCodeEventStream;
  logger: MorseLogger;
  maxSessionsPerProject?: number;
  /** Overrides the MCP administration; tests inject one with a temp config dir. */
  mcp?: OpenCodeMcp;
  prompts?: OpenCodePrompts;
  /**
   * The OpenCode config dir this engine's agents resolve command templates
   * from. Omitted means the host's XDG dir; a bot passes its own so no template
   * is read out of the user's config.
   */
  configDir?: string;
  /**
   * The environment the OpenCode server was started with. The config guard
   * fingerprints the config tree that environment resolves, so a bot's
   * redirected XDG roots are the ones it stats rather than the host's.
   */
  env?: NodeJS.ProcessEnv;
}

export class OpenCodeEngine extends SessionEngine implements AgentIntegration {
  readonly kind = 'opencode';
  /** This object *is* the engine, so the composite points at itself. */
  readonly engine: SessionEngine = this;
  readonly factory: OpenCodeAgentFactory;
  readonly catalog: OpenCodeSessionCatalog;
  /** OpenCode's own administration: its MCP servers, from `opencode.json`. */
  readonly extras: AgentExtras;

  constructor(private readonly deps: OpenCodeEngineDeps) {
    super();
    const mcp =
      deps.mcp ??
      new OpenCodeMcp(deps.configDir === undefined ? {} : { configDir: deps.configDir });
    const prompts = deps.prompts ?? new OpenCodePrompts();
    // Small wrappers rather than the class itself: the ports speak in
    // `Record<string, unknown>` and `string` scopes, because `@morse/system`
    // must not know OpenCode's payload types. The casts live at this edge.
    const extras: AgentExtras = {
      // The manager owns the tree (config dir, ownership, a bot's root), so it
      // is also the one that decides which paths a fix may rewrite.
      fix: (request) => Promise.resolve(mcp.fix(request)),
      mcp: {
        configSignature: (cwd) => mcp.configSignature(cwd),
        status: (cwd, options) =>
          Promise.resolve(mcp.status(cwd, options as OpenCodeMcpStatusOptions | undefined)),
        add: (input, cwd) => Promise.resolve(mcp.add(input as McpServerInput, cwd)),
        remove: (name, cwd, scope) =>
          Promise.resolve(mcp.remove(name, cwd, scope as McpConfigScope | undefined)),
        setEnabled: (name, enabled, cwd, scope) =>
          Promise.resolve(mcp.setEnabled(name, enabled, cwd, scope as McpConfigScope | undefined)),
        trustProject: (cwd) => Promise.resolve(mcp.trustProject(cwd)),
      },
      prompts: {
        list: (cwd) => Promise.resolve(prompts.list(cwd)),
        save: (input, cwd) => Promise.resolve(prompts.save(input as never, cwd)),
        delete: (name, scope, cwd, source) =>
          Promise.resolve(prompts.delete(name, scope as never, cwd, source as never)),
      },
    };
    this.extras = extras;
    // One guard per engine: every session and every draft shares the server, so
    // they share the reload decision too. Ownership comes from the connection —
    // only a server Morse started may be told to reload itself.
    const guard = new OpenCodeConfigGuard({
      api: deps.api,
      logger: deps.logger,
      owned: deps.connection.owned,
      ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
    this.factory = new OpenCodeAgentFactory({
      api: deps.api,
      stream: deps.stream,
      logger: deps.logger,
      guard,
      ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
    });
    this.catalog = new OpenCodeSessionCatalog({
      api: deps.api,
      ...(deps.maxSessionsPerProject === undefined
        ? {}
        : { maxSessionsPerProject: deps.maxSessionsPerProject }),
    });
  }

  /** The server this engine talks to, for diagnostics and host logs. */
  get baseUrl(): string {
    return this.deps.connection.baseUrl;
  }

  /** True when Morse started the server and will stop it on dispose. */
  get owned(): boolean {
    return this.deps.connection.owned;
  }

  /**
   * Every session the server holds, including ones created outside Morse.
   *
   * OpenCode's record carries no message count, so the report says zero ("not
   * reported") rather than inventing one; the token is the last-update stamp,
   * which is what makes an unchanged session cost no rewrite.
   */
  override async scan(): Promise<AgentSessionInfo[]> {
    const sessions = await this.catalog.allSessions();
    return sessions.flatMap((session) => {
      const cwd = session.location?.directory;
      if (cwd === undefined || cwd.length === 0) {
        return [];
      }
      const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
      return [
        {
          sessionId: session.id,
          title: session.title,
          cwd,
          createdAt: session.time?.created ?? updatedAt,
          updatedAt,
          messageCount: 0,
          ...(session.parentID !== undefined && session.parentID.length > 0
            ? { parentSessionId: session.parentID, subagent: true }
            : session.fork?.sessionID === undefined
              ? {}
              : { parentSessionId: session.fork.sessionID }),
          token: `${updatedAt}:${session.outcome ?? ''}`,
        },
      ];
    });
  }

  /** Stops the shared stream and, only if Morse started it, the server. */
  override async dispose(): Promise<void> {
    await this.deps.stream.close();
    await this.deps.connection.close();
  }
}

/** Creates the engine for a host: attach to `url`, or spawn a private server. */
export async function createOpenCodeEngine(
  options: OpenCodeConnectionOptions & {
    logger: MorseLogger;
    maxSessionsPerProject?: number;
    /** How long a full session list is trusted before re-reading it. */
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
  },
): Promise<OpenCodeEngine> {
  const connection = await connectOpenCode(options);
  const api = new OpenCodeApi(connection);
  const stream = new OpenCodeEventStream(connection, {
    logger: options.logger,
    ...(options.reconnectBaseMs === undefined ? {} : { reconnectBaseMs: options.reconnectBaseMs }),
    ...(options.reconnectMaxMs === undefined ? {} : { reconnectMaxMs: options.reconnectMaxMs }),
  });
  return new OpenCodeEngine({
    connection,
    api,
    stream,
    logger: options.logger,
    ...(options.maxSessionsPerProject === undefined
      ? {}
      : { maxSessionsPerProject: options.maxSessionsPerProject }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

/**
 * Registers OpenCode only when this machine can actually run it.
 *
 * A configured URL always tries (a wrong one is reported and the host keeps its
 * other engines); otherwise the binary decides. `undefined` means "not
 * installed", which is a pi-only host paying nothing — not an error.
 *
 * "Can run it" is the resolved spawn plan, not the file path: on Windows the
 * `opencode` on PATH is usually a `.cmd` shim, and the plan is what starts the
 * program inside it. Detection and spawn therefore use the same resolution, so a
 * host cannot offer an OpenCode that then fails to start.
 */
export async function openOpenCodeEngine(options: {
  url?: string;
  password?: string;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  logger: MorseLogger;
  maxSessionsPerProject?: number;
}): Promise<OpenCodeEngine | undefined> {
  const configuredBin = options.bin?.trim();
  const bin =
    configuredBin === undefined || configuredBin.length === 0 ? 'opencode' : configuredBin;
  if (options.url === undefined) {
    const spawn = resolveOpenCodeSpawn(bin, options.env ?? process.env);
    if (spawn === undefined) {
      return undefined;
    }
    try {
      return await createOpenCodeEngine({ ...options, bin, spawn });
    } catch (error: unknown) {
      options.logger.error('Could not start the OpenCode engine', error);
      return undefined;
    }
  }
  try {
    return await createOpenCodeEngine(options);
  } catch (error: unknown) {
    options.logger.error('Could not connect to the configured OpenCode server', error);
    return undefined;
  }
}

/** Creates one session per workspace, or attaches to a persisted engine session. */
export class OpenCodeAgentFactory implements AgentGatewayFactory {
  /** The `AgentEngineRef.engine` value this factory's sessions carry. */
  readonly kind = 'opencode';

  constructor(
    private readonly deps: {
      api: OpenCodeApi;
      stream: OpenCodeEventStream;
      logger: MorseLogger;
      /** The engine's shared config guard: a changed file reloads the server. */
      guard: OpenCodeConfigGuard;
      /** Where this engine's agents read global command templates from. */
      configDir?: string;
    },
  ) {}

  create(input: {
    workspace: WorkspaceRef;
    sessionId?: string;
    mode?: string;
  }): Promise<AgentGateway> {
    return OpenCodeAgent.open({
      api: this.deps.api,
      stream: this.deps.stream,
      workspace: input.workspace,
      logger: this.deps.logger,
      guard: this.deps.guard,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(this.deps.configDir === undefined ? {} : { configDir: this.deps.configDir }),
    });
  }

  /**
   * The config fingerprint a draft cache keys on: when the reader edits
   * `opencode.json`, the cached draft must miss so the next probe reloads the
   * server and reads the new catalogs. Synchronous, because a cache lookup is.
   */
  configSignature(options: { workspace: WorkspaceRef; engine?: string }): string {
    return this.deps.guard.signature(options.workspace.cwd);
  }

  /**
   * The manual path: reload the server's config now, whatever state it is in.
   * The guard logs a failed reload instead of throwing, which is what the
   * control wants — a warning, not a broken command.
   */
  reloadConfig(options: { engine?: string; cwd?: string }): Promise<void> {
    return this.deps.guard.reloadNow(options.cwd);
  }

  /**
   * The draft catalog without a session: models, their levels, and the composer's
   * commands/skills, read straight from the server's catalogs. No session is
   * created, so opening the empty panel does not litter the server's history.
   *
   * The draft names the model the *effective agent* is configured to run — the
   * picked mode's agent, else the configured default agent — because that is
   * what the first prompt will use. `/model/default` is only the server's own
   * fallback for an agent that names no model the catalog knows, and an
   * explicitly picked model always wins. A model no catalog can resolve stays
   * unset rather than naming one that will not serve.
   *
   * `engine` is the router's selection and goes unused here: reaching this
   * factory already means the router picked it.
   */
  async probeDefaults(input: {
    workspace: WorkspaceRef;
    engine?: string;
    model?: ModelRef;
    mode?: string;
  }): Promise<AgentGateway> {
    const directory = input.workspace.cwd;
    // The server reads its config once, so a file edited since then is invisible
    // until it reloads. Seeding happens on the first probe, which must not reload
    // a server that already started from these files.
    await this.deps.guard.ensureFresh(directory);
    const [models, commands, agentCatalog, defaultModel] = await Promise.all([
      this.deps.api
        .get<ApiModel[]>('/model', { 'location[directory]': directory })
        .catch((error: unknown): ApiModel[] => {
          this.deps.logger.warn('Could not read the OpenCode model catalog', error);
          return [];
        }),
      readAvailableCommands(this.deps.api, directory, this.deps.logger, this.deps.configDir),
      readAgentCatalog(this.deps.api, directory, this.deps.logger),
      readDefaultModel(this.deps.api, directory, this.deps.logger),
    ]);
    const catalog = [...models];
    const known = (providerID: string, id: string): ApiModel | undefined =>
      catalog.find((model) => model.providerID === providerID && model.id === id);
    const mode = input.mode ?? defaultModeId(agentCatalog.modes);
    const agentModel = mode === undefined ? undefined : agentCatalog.models.get(mode);

    // An explicit pick is the reader's choice even when it does not resolve: a
    // model the catalog lacks is reported as no model rather than silently
    // swapped for one the reader never chose.
    let selected: ApiModel | undefined;
    if (input.model !== undefined) {
      selected = known(input.model.provider, input.model.id);
    } else {
      selected =
        agentModel === undefined ? undefined : known(agentModel.providerID, agentModel.id);
      if (selected === undefined && defaultModel !== undefined) {
        // The server's own fallback. Append it when the catalog a stale server
        // returned does not list it yet, so the picker can name it.
        const fallback = known(defaultModel.providerID, defaultModel.id);
        selected = fallback ?? defaultModel;
        if (fallback === undefined) {
          catalog.push(defaultModel);
        }
      }
    }
    const state: AgentSessionState = {
      workspace: input.workspace,
      ...(selected === undefined ? {} : { model: toModelRef(selected) }),
      thinkingLevel: thinkingLevelOf(selected, undefined),
      availableModels: toModelRefs(catalog),
      availableThinkingLevels: thinkingLevelsOf(selected),
      availableCommands: [...commands],
      ...(mode === undefined ? {} : { mode }),
      ...(agentCatalog.modes.length === 0 ? {} : { availableModes: [...agentCatalog.modes] }),
      streaming: false,
    };
    return new ProbeGateway(state, this.kind);
  }
}

/**
 * A gateway that only answers `state()`: what the empty panel shows before any
 * session exists. Every action refuses, because there is no conversation to act
 * on — the registry calls `state()` and `dispose()` only.
 */
class ProbeGateway implements AgentGateway {
  constructor(
    private readonly snapshot: AgentSessionState,
    readonly kind: string,
  ) {}

  subscribe(_listener: AgentEventListener): () => void {
    return () => undefined;
  }

  state(): Promise<AgentSessionState> {
    return Promise.resolve(this.snapshot);
  }

  history(): Promise<AgentHistoryPage> {
    return Promise.resolve({ entries: [], hasOlder: false });
  }

  prompt(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no session to prompt.'));
  }

  userMessages(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no conversation to fork.'));
  }

  rewrite(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no conversation to fork.'));
  }

  clone(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no conversation to fork.'));
  }

  fork(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no conversation to fork.'));
  }

  abort(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no run to abort.'));
  }

  setModel(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no session to change.'));
  }

  setThinkingLevel(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no session to change.'));
  }

  compact(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft has no context to compact.'));
  }

  respondToInteraction(): Promise<never> {
    return Promise.reject(new UnsupportedByHostError('A draft asked nothing.'));
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
