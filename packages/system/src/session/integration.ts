import type { AgentGatewayFactory, SessionEngine } from '@morse/agent';
import type { SessionCatalog } from './ports.js';

/**
 * Everything a host needs from one harness, in one value.
 *
 * A composite rather than members on `SessionEngine` because `SessionCatalog` is
 * Morse's: declaring it on an engine that lives in `@morse/agent` would make that
 * package import `@morse/system`, and the two packages would be one package with
 * two names. The engine stays the harness's own (kind, factory, `scan?()`); the
 * catalog joins it here, on Morse's side of the boundary.
 *
 * `extras` carries the engine-only administration a host may offer — MCP servers,
 * prompt templates, the installed version, the CLI. They are optional because
 * they are genuinely absent for some harnesses: OpenCode has no `mcp.json` editor
 * and no prompt-template files, so it supplies none, and a host hides those
 * affordances instead of faking them.
 */

/**
 * MCP server administration, in the vocabulary a host's MCP manager needs.
 *
 * Returns are `unknown` on purpose: the result is a panel DTO whose shape belongs
 * to the engine (pi's `mcp list --json`), and Morse only relays it. The port is
 * what the host gates on, not the payload.
 */
export interface AgentMcpExtras {
  /** A cheap fingerprint of the server configs, for change watching. */
  configSignature(cwd?: string): Promise<string>;
  status(cwd?: string): Promise<unknown>;
  add(input: unknown, cwd?: string): Promise<unknown>;
  remove(name: string, cwd?: string, scope?: string): Promise<unknown>;
  setEnabled(name: string, enabled: boolean, cwd?: string, scope?: string): Promise<unknown>;
  trustProject(cwd: string): Promise<unknown>;
}

/** Prompt-template administration, when the engine keeps templates as files. */
export interface AgentPromptExtras {
  list(cwd: string): Promise<unknown>;
  save(input: unknown, cwd: string): Promise<unknown>;
  delete(name: string, scope: string, cwd: string): Promise<unknown>;
}

export interface AgentExtras {
  /** Managing MCP servers, when the engine has a config to manage. */
  mcp?: AgentMcpExtras;
  /** Editing prompt templates, when the engine loads them from files. */
  prompts?: AgentPromptExtras;
  /** The installed engine version, for the "a newer one is out" notice. */
  version?(): string | undefined;
  /** The engine's CLI, when host commands shell out to it. Presence = available. */
  cli?: unknown;
}

export interface AgentIntegration {
  /** The harness: its kind and, when it can, a report of the sessions it holds. */
  readonly engine: SessionEngine;
  /** Creates a session for a workspace, or resumes a persisted one. */
  readonly factory: AgentGatewayFactory;
  /** Reads a workspace's persisted sessions, for the sidebar. */
  readonly catalog: SessionCatalog;
  /**
   * Engine-only administration. Absent for a harness that has none — the host
   * then hides its MCP/prompt editors and its update notice.
   */
  readonly extras?: AgentExtras;
}
