/**
 * `@morse/integration-opencode`: OpenCode as a Morse engine.
 *
 * The adapter drives an OpenCode server over its v2 HTTP API — one long-lived
 * server process shared by every session, one event stream for the whole engine —
 * and implements the `@morse/agent` ports against it. It depends on the harness
 * contract (`@morse/agent`) and on Morse's own host-side shapes (`@morse/system`)
 * exactly like `@morse/integration-pi`; it is not an SDK.
 */

export {
  OpenCodeEngine,
  OpenCodeAgentFactory,
  createOpenCodeEngine,
  openOpenCodeEngine,
  type OpenCodeEngineDeps,
} from './opencode-engine.js';
export { OpenCodeAgent, type ApiSessionInfo } from './opencode-agent.js';
export {
  OPENCODE_BOT_CAPABILITIES,
  botOpenCodeEnv,
  createBotOpenCodeEngine,
  importOpenCodeGlobalConfig,
  opencodeBotAdapterFactory,
  writeOpenCodeCredentials,
  writeOpenCodeProviders,
  writeOpenCodeSubagents,
  type BotOpenCodeEngineOptions,
} from './bot-engine.js';
export { importOpenCodeCredentials } from './internal/stored-auth.js';
export { OpenCodeSessionCatalog } from './opencode-session-catalog.js';
export {
  findOpenCodeBinary,
  resolveOpenCodeSpawn,
  type OpenCodeSpawn,
} from './internal/resolve-opencode.js';
export {
  connectOpenCode,
  OPENCODE_INSTALL_COMMAND,
  type OpenCodeConnection,
  type OpenCodeConnectionOptions,
} from './internal/connection.js';
export type { ApiModel } from './internal/model-mapping.js';

export {
  openCodeBotLayout,
  writeOpenCodeBotConfig,
  openCodeConfigPath,
  openCodeLegacyPersonaPath,
  OPENCODE_BOT_AGENT,
} from './bot-layout.js';
export {
  OPENCODE_BUS_PLUGIN_FILE,
  openCodeBusPluginPath,
  openCodeBusPluginSource,
} from './bot-bus-plugin.js';

export {
  OpenCodeEngineDefinition,
  OpenCodeEngineInstance,
  type OpenCodeEngineOptions,
} from './engine/open-code-engine.js';
export { OpenCodeMcpSection } from './engine/open-code-mcp-section.js';
export { OpenCodeMcpStore } from './engine/open-code-mcp-store.js';
export { discoverOpenCodeConfigPaths } from './engine/config-discovery.js';
