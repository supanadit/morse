import type { AgentGatewayFactory, MorseLogger, SessionCatalog } from '@morse/core';
import { PiRpcAgentFactory, type PiRpcAgentFactoryOptions } from './pi-rpc-agent-factory.js';
import { PiMcp } from './pi-mcp.js';
import { PiRpcSessionCatalog } from './pi-rpc-session-catalog.js';
import { resolvePi, resolvePiCli, type PiCliSpawn, type PiSpawn } from './internal/resolve-pi.js';

export interface PiRpcAdapterConfig extends PiRpcAgentFactoryOptions {
  sessionDir?: string;
  maxSessions?: number;
  /** How session files are removed; the host supplies its own (see the catalog). */
  removeSessionFile?: (path: string) => Promise<void>;
}

export interface PiRpcAdapter {
  factory: AgentGatewayFactory;
  catalog: SessionCatalog;
  /** pi's MCP configuration, read and written through the CLI and `mcp.json`. */
  mcp: PiMcp;
  /** Resolves the spawn command; throws with an actionable message when pi is missing. */
  describe(): PiSpawn;
  /** The `pi` CLI when it can be run, for host capabilities that need a subcommand. */
  describeCli(): PiCliSpawn | undefined;
}

/**
 * Wires the pi RPC adapter. Both hosts (VS Code extension and NestJS server)
 * call this and receive the same ports — only the delivery differs.
 */
export function createPiRpcAdapter(config: PiRpcAdapterConfig, logger: MorseLogger): PiRpcAdapter {
  const factory = new PiRpcAgentFactory(config, logger);
  const catalog = new PiRpcSessionCatalog({
    sessionDir: config.sessionDir,
    maxSessions: config.maxSessions,
    env: config.env,
    removeFile: config.removeSessionFile,
  });
  const cliOptions = {
    piPath: config.piPath,
    nodeEntryPath: config.nodeEntryPath,
    env: config.env,
  };
  const mcp = new PiMcp(cliOptions);
  return {
    factory,
    catalog,
    mcp,
    describe: () =>
      resolvePi({
        piPath: config.piPath,
        nodeEntryPath: config.nodeEntryPath,
        sessionDir: config.sessionDir,
        noSession: config.noSession,
        extraArgs: config.extraArgs,
        env: config.env,
      }),
    describeCli: () => {
      try {
        return resolvePiCli(cliOptions);
      } catch {
        return undefined;
      }
    },
  };
}
