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
export { OpenCodeSessionCatalog } from './opencode-session-catalog.js';
export { findOpenCodeBinary } from './internal/resolve-opencode.js';
export {
  connectOpenCode,
  type OpenCodeConnection,
  type OpenCodeConnectionOptions,
} from './internal/connection.js';
export type { ApiModel } from './internal/model-mapping.js';
