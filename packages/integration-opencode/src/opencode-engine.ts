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
import { UnsupportedByHostError, type AgentIntegration, type MorseLogger } from '@morse/system';
import {
  connectOpenCode,
  type OpenCodeConnection,
  type OpenCodeConnectionOptions,
} from './internal/connection.js';
import { OpenCodeApi } from './internal/client.js';
import { OpenCodeEventStream } from './internal/event-stream.js';
import { defaultModeId, readAgentModes, readDefaultModel } from './internal/catalog.js';
import {
  thinkingLevelOf,
  thinkingLevelsOf,
  toModelRef,
  toModelRefs,
  type ApiModel,
} from './internal/model-mapping.js';
import { OpenCodeAgent, readAvailableCommands } from './opencode-agent.js';
import { OpenCodeSessionCatalog } from './opencode-session-catalog.js';
import { findOpenCodeBinary } from './internal/resolve-opencode.js';

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
}

export class OpenCodeEngine extends SessionEngine implements AgentIntegration {
  readonly kind = 'opencode';
  /** This object *is* the engine, so the composite points at itself. */
  readonly engine: SessionEngine = this;
  readonly factory: OpenCodeAgentFactory;
  readonly catalog: OpenCodeSessionCatalog;

  constructor(private readonly deps: OpenCodeEngineDeps) {
    super();
    this.factory = new OpenCodeAgentFactory({
      api: deps.api,
      stream: deps.stream,
      logger: deps.logger,
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
  });
}

/**
 * Registers OpenCode only when this machine can actually run it.
 *
 * A configured URL always tries (a wrong one is reported and the host keeps its
 * other engines); otherwise the binary decides. `undefined` means "not
 * installed", which is a pi-only host paying nothing — not an error.
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
  if (options.url === undefined) {
    const binary = findOpenCodeBinary(
      configuredBin === undefined || configuredBin.length === 0 ? 'opencode' : configuredBin,
      options.env ?? process.env,
    );
    if (binary === undefined) {
      return undefined;
    }
    try {
      return await createOpenCodeEngine({ ...options, bin: binary });
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
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    });
  }

  /**
   * The draft catalog without a session: models, their levels, and the composer's
   * commands/skills, read straight from the server's catalogs. No session is
   * created, so opening the empty panel does not litter the server's history.
   */
  async probeDefaults(input: { workspace: WorkspaceRef; model?: ModelRef }): Promise<AgentGateway> {
    const directory = input.workspace.cwd;
    const [models, commands, modes, defaultModel] = await Promise.all([
      this.deps.api
        .get<ApiModel[]>('/model', { 'location[directory]': directory })
        .catch((error: unknown): ApiModel[] => {
          this.deps.logger.warn('Could not read the OpenCode model catalog', error);
          return [];
        }),
      readAvailableCommands(this.deps.api, directory, this.deps.logger),
      readAgentModes(this.deps.api, directory, this.deps.logger),
      readDefaultModel(this.deps.api, directory, this.deps.logger),
    ]);
    const catalog =
      defaultModel === undefined ||
      models.some(
        (model) => model.providerID === defaultModel.providerID && model.id === defaultModel.id,
      )
        ? models
        : [...models, defaultModel];
    const selected =
      input.model === undefined
        ? defaultModel
        : catalog.find(
            (model) => model.providerID === input.model?.provider && model.id === input.model?.id,
          );
    const mode = defaultModeId(modes);
    const state: AgentSessionState = {
      workspace: input.workspace,
      ...(selected === undefined ? {} : { model: toModelRef(selected) }),
      thinkingLevel: thinkingLevelOf(selected, undefined),
      availableModels: toModelRefs(catalog),
      availableThinkingLevels: thinkingLevelsOf(selected),
      availableCommands: [...commands],
      ...(mode === undefined ? {} : { mode }),
      ...(modes.length === 0 ? {} : { availableModes: [...modes] }),
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

  forkMessages(): Promise<never> {
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
