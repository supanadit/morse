import { homedir } from 'node:os';
import { SessionEngine, type AgentGatewayFactory, type AgentSessionInfo } from '@morse/agent';
import type { AgentExtras, AgentIntegration, MorseLogger, SessionCatalog } from '@morse/system';
import {
  resolveEngineContext,
  type ConfigIssue,
  type ConfigMutation,
  type ConfigScope,
} from '@morse/engine-config';
import { PiRpcAgentFactory, type PiRpcAgentFactoryOptions } from './pi-rpc-agent-factory.js';
import { PiEngineDefinition, type PiEngineInstance } from './engine/pi-engine.js';
import { PiMcp, type McpConfigScope, type McpServerInput } from './pi-mcp.js';
import { PiPrompts, type PromptScope, type PromptTemplateInput } from './pi-prompts.js';
import { McpInspector } from './internal/mcp-client.js';
import { PiRpcSessionCatalog } from './pi-rpc-session-catalog.js';
import {
  resolvePi,
  resolvePiCli,
  readPiVersion,
  type PiCliSpawn,
  type PiSpawn,
} from './internal/resolve-pi.js';

export interface PiRpcAdapterConfig extends PiRpcAgentFactoryOptions {
  sessionDir?: string;
  /** Sessions shown per project before "Load more"; every project is still listed. */
  maxSessionsPerProject?: number;
  /**
   * @deprecated A single global cap made whole projects disappear. Prefer
   * `maxSessionsPerProject`; this now only sets an optional ceiling on the whole
   * list and defaults to unlimited.
   */
  maxSessions?: number;
  /** How session files are removed; the host supplies its own (see the catalog). */
  removeSessionFile?: (path: string) => Promise<void>;
  /** The Morse build, reported to an MCP server as `clientInfo.version`. */
  clientVersion?: string;
}

export interface PiRpcAdapter extends AgentIntegration {
  /** pi's MCP configuration, read and written through the CLI and `mcp.json`. */
  mcp: PiMcp;
  /** pi's prompt templates, read and written as the `.md` files pi loads. */
  prompts: PiPrompts;
  /**
   * Connects to an MCP server before it is added, so the reader can see what it
   * offers. A client Morse owns; no inspector package is installed.
   */
  inspector: McpInspector;
  /** Resolves the spawn command; throws with an actionable message when pi is missing. */
  describe(): PiSpawn;
  /**
   * The installed pi version, for the "a newer pi is out" notice. Read once and
   * cached: both hosts call this while building capabilities, on every
   * connection. `undefined` when pi is missing or its package is unreadable.
   */
  version(): string | undefined;
  /** The `pi` CLI when it can be run, for host capabilities that need a subcommand. */
  describeCli(): PiCliSpawn | undefined;
}

/**
 * Wires the pi RPC adapter. Both hosts (VS Code extension and NestJS server)
 * call this and receive the same ports — only the delivery differs.
 */
export function createPiRpcAdapter(config: PiRpcAdapterConfig, logger: MorseLogger): PiRpcAdapter {
  return new PiRpcEngine(config, logger);
}

/**
 * The pi engine, as `SessionEngine` rather than a bare object.
 *
 * Extending the abstract engine is what gives `reconcile()` its `scan()`: the pi
 * catalog is the one thing in this repo that can enumerate sessions Morse did not
 * create, so pi is the engine that makes a session started with the `pi` CLI in a
 * terminal appear in the sidebar.
 */
class PiRpcEngine extends SessionEngine implements PiRpcAdapter, AgentIntegration {
  readonly kind = 'pi';
  /** This object *is* the engine, so the composite points at itself. */
  readonly engine: SessionEngine = this;
  readonly factory: AgentGatewayFactory;
  readonly catalog: SessionCatalog;
  readonly mcp: PiMcp;
  readonly prompts: PiPrompts;
  readonly inspector: McpInspector;
  /** The unpaged catalog `scan()` reads, so a reconcile never mistakes a page for the whole. */
  private readonly scanCatalog: PiRpcSessionCatalog;
  /** pi's host-side administration, behind the optional capability ports. */
  readonly extras: AgentExtras;
  /** Builds the instance `fix` resolves a config path from. */
  private readonly definition = new PiEngineDefinition();
  private cachedVersion: string | null | undefined;

  constructor(
    private readonly config: PiRpcAdapterConfig,
    logger: MorseLogger,
  ) {
    super();
    this.factory = new PiRpcAgentFactory(config, logger);
    this.catalog = new PiRpcSessionCatalog({
      sessionDir: config.sessionDir,
      maxSessionsPerProject: config.maxSessionsPerProject,
      maxSessions: config.maxSessions,
      env: config.env,
      removeFile: config.removeSessionFile,
    });
    // The catalog pages its list for the sidebar, but `scan()` must see every
    // session: reconciling a page would remove the 482 sessions it did not read.
    this.scanCatalog = new PiRpcSessionCatalog({
      sessionDir: config.sessionDir,
      maxSessionsPerProject: Number.MAX_SAFE_INTEGER,
      env: config.env,
      removeFile: config.removeSessionFile,
    });
    this.inspector = new McpInspector({ clientVersion: config.clientVersion });
    // The same clock-bound prober the editor uses: `status({ probe: true })`
    // connects servers through the one client Morse owns.
    this.mcp = new PiMcp({
      piPath: config.piPath,
      nodeEntryPath: config.nodeEntryPath,
      env: config.env,
      inspector: this.inspector,
    });
    this.prompts = new PiPrompts({ env: config.env });
    // Small wrappers rather than the classes themselves: the ports speak in
    // `Record<string, unknown>` and `string` scopes, because `@morse/system` must
    // not know pi's payload types. The casts live here, at the adapter edge.
    this.extras = {
      mcp: {
        configSignature: (cwd) => this.mcp.configSignature(cwd),
        status: (cwd, options) => this.mcp.status(cwd, options),
        add: (input, cwd) => this.mcp.add(input as unknown as McpServerInput, cwd),
        remove: (name, cwd, scope) =>
          this.mcp.remove(name, cwd, scope as McpConfigScope | undefined),
        setEnabled: (name, enabled, cwd, scope) =>
          this.mcp.setEnabled(name, enabled, cwd, scope as McpConfigScope | undefined),
        trustProject: (cwd) => Promise.resolve(this.mcp.trustProject(cwd)),
      },
      prompts: {
        list: (cwd) => Promise.resolve(this.prompts.list(cwd)),
        save: (input, cwd) =>
          Promise.resolve(this.prompts.save(input as unknown as PromptTemplateInput, cwd)),
        delete: (name, scope, cwd) =>
          Promise.resolve(this.prompts.delete(name, scope as PromptScope, cwd)),
      },
      fix: (request) => Promise.resolve(this.fix(request)),
      version: () => this.version(),
      cli: this.describeCli(),
    };
  }

  /**
   * Rewrite one config file as strict JSON, so a later write can land.
   *
   * The panel names the file its `ConfigIssue` reported, and only a path the
   * engine itself resolves for that `fileId`/`scope`/`cwd` may be touched: a fix
   * is a repair of pi's own config, never a general file rewrite. pi has one
   * fixable file id today (`mcp`); anything else is refused as unsupported.
   */
  private fix(request: {
    fileId: string;
    path: string;
    scope: ConfigScope;
    cwd?: string;
  }): ConfigMutation {
    const cwd = request.cwd !== undefined && request.cwd.length > 0 ? request.cwd : undefined;
    if (request.fileId !== 'mcp') {
      return fixRefusal(request, `pi has no fixable config file "${request.fileId}".`);
    }
    try {
      const instance = this.instance(cwd);
      const paths = instance.paths(request.fileId, request.scope, cwd);
      if (request.path !== paths.write && !paths.read.includes(request.path)) {
        return fixRefusal(
          request,
          `"${request.path}" is not one of pi's ${request.scope} config paths.`,
        );
      }
      return instance.fileAt(request.fileId, request.path, request.scope).normalize();
    } catch (error: unknown) {
      return fixRefusal(request, describeFixError(error));
    }
  }

  /**
   * The instance one call resolves through. A configured agent directory is a
   * bot's isolated root when there is no project, and pi's user tree (named
   * through `PI_CODING_AGENT_DIR`) when a project's `.pi` files take precedence.
   */
  private instance(cwd: string | undefined): PiEngineInstance {
    const env = this.config.env ?? process.env;
    const agentDir = env.PI_CODING_AGENT_DIR;
    if (agentDir !== undefined && agentDir.length > 0 && cwd === undefined) {
      return this.definition.isolated(agentDir, { env, home: homedir() }) as PiEngineInstance;
    }
    return this.definition.create(
      resolveEngineContext({
        ownership: 'user',
        home: homedir(),
        ...(cwd === undefined ? {} : { cwd }),
        env:
          agentDir === undefined || agentDir.length === 0
            ? env
            : { ...env, PI_CODING_AGENT_DIR: agentDir },
      }),
    );
  }

  /**
   * Every session pi holds, in pi's own terms.
   *
   * Deliberately does not build a Morse record: deriving Morse's id, resolving the
   * title fallback and writing the parent link are the application's job, so this
   * adapter never learns Morse's id scheme. The token is
   * `updatedAt:messageCount` — both come from the catalog's cached scan, so an
   * unchanged session costs the catalog nothing extra, and any appended message
   * moves the count. A session started with `pi` in a terminal therefore shows up
   * on the next reconcile without Morse ever reading the transcript.
   */
  override async scan(): Promise<AgentSessionInfo[]> {
    const summaries = await this.scanCatalog.list();
    return summaries.map((summary) => ({
      sessionId: summary.id,
      file: summary.id,
      title: summary.title,
      cwd: summary.cwd,
      createdAt: summary.updatedAt,
      updatedAt: summary.updatedAt,
      messageCount: summary.messageCount,
      ...(summary.parentId === undefined ? {} : { parentSessionId: summary.parentId }),
      ...(summary.subagent === undefined ? {} : { subagent: summary.subagent }),
      token: `${summary.updatedAt}:${summary.messageCount}`,
    }));
  }

  describe(): PiSpawn {
    return resolvePi({
      piPath: this.config.piPath,
      nodeEntryPath: this.config.nodeEntryPath,
      sessionDir: this.config.sessionDir,
      noSession: this.config.noSession,
      extraArgs: this.config.extraArgs,
      env: this.config.env,
    });
  }

  version(): string | undefined {
    if (this.cachedVersion === undefined) {
      try {
        this.cachedVersion =
          readPiVersion(
            resolvePi({
              piPath: this.config.piPath,
              nodeEntryPath: this.config.nodeEntryPath,
              env: this.config.env,
            }),
          ) ?? null;
      } catch {
        this.cachedVersion = null;
      }
    }
    return this.cachedVersion ?? undefined;
  }

  describeCli(): PiCliSpawn | undefined {
    try {
      return resolvePiCli({
        piPath: this.config.piPath,
        nodeEntryPath: this.config.nodeEntryPath,
        env: this.config.env,
      });
    } catch {
      return undefined;
    }
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
    issues: [fixIssue(request, message)],
  };
}

function fixIssue(
  request: { fileId: string; path: string; scope: ConfigScope },
  message: string,
): ConfigIssue {
  return {
    file: request.path,
    fileId: request.fileId,
    scope: request.scope,
    code: 'unsupported',
    message,
    fixable: false,
  };
}

function describeFixError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
