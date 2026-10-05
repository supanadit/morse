import type {
  AgentGateway,
  AgentGatewayFactory,
  ModelRef,
  MorseLogger,
  WorkspaceRef,
} from '@morse/core';
import { PiRpcAgent } from './pi-rpc-agent.js';
import { resolvePi, type ResolvePiOptions } from './internal/resolve-pi.js';

export interface PiRpcAgentFactoryOptions {
  piPath?: string;
  nodeEntryPath?: string;
  sessionDir?: string;
  noSession?: boolean;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

/** Implements `AgentGatewayFactory` (declared by core) by spawning `pi --mode rpc`. */
export class PiRpcAgentFactory implements AgentGatewayFactory {
  constructor(
    private readonly options: PiRpcAgentFactoryOptions,
    private readonly logger: MorseLogger,
  ) {}

  async create(input: {
    workspace: WorkspaceRef;
    sessionId?: string;
  }): Promise<AgentGateway> {
    const resolveOptions: ResolvePiOptions = {
      piPath: this.options.piPath,
      nodeEntryPath: this.options.nodeEntryPath,
      sessionDir: this.options.sessionDir,
      noSession: this.options.noSession,
      // The catalog hands back session file paths as ids, which is what
      // `pi --session <path>` expects.
      sessionPath: input.sessionId,
      extraArgs: this.options.extraArgs,
      env: this.options.env,
    };
    return this.spawnAgent(resolveOptions, input.workspace, input.sessionId);
  }

  /**
   * A gateway that never records: pi is forced onto `--no-session` and no
   * session path is passed, so this spawn cannot touch the session list on
   * disk. Its only job is to answer state once — model catalog, thinking
   * levels, commands — for the draft (empty panel) state.
   */
  async probeDefaults(input: { workspace: WorkspaceRef; model?: ModelRef }): Promise<AgentGateway> {
    const resolveOptions: ResolvePiOptions = {
      piPath: this.options.piPath,
      nodeEntryPath: this.options.nodeEntryPath,
      sessionDir: this.options.sessionDir,
      noSession: true,
      extraArgs: this.options.extraArgs,
      env: this.options.env,
    };
    const agent = await this.spawnAgent(resolveOptions, input.workspace);
    // Selecting the model on the probe is what makes pi report that model's
    // thinking levels (they are read per current model), so the draft picker
    // mirrors the TUI before a real session exists.
    if (input.model) {
      await agent.setModel(input.model).catch((error: unknown) => {
        this.logger.warn('Could not select the model on the draft probe', error);
      });
    }
    return agent;
  }

  private async spawnAgent(
    resolveOptions: ResolvePiOptions,
    workspace: WorkspaceRef,
    sessionPath?: string,
  ): Promise<AgentGateway> {
    const spawn = resolvePi(resolveOptions);
    this.logger.info(
      `Starting pi agent (${spawn.source}): ${spawn.command} ${spawn.args.join(' ')}`,
    );

    const agent = new PiRpcAgent({
      spawn,
      workspace,
      logger: this.logger,
      sessionPath,
      env: this.options.env,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    await agent.initialize();
    return agent;
  }
}
