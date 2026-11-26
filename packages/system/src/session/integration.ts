import type { AgentGatewayFactory, SessionEngine } from '@morse/agent';
import type { ConfigScope } from '@morse/protocol';
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
 * they are genuinely absent for some harnesses: a host hides the affordances of
 * an extras key an engine does not supply instead of faking it. OpenCode
 * supplies both its MCP administration and its prompt-command administration
 * (markdown `commands/` plus `opencode.json`'s `command` key).
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
  /** `probe` asks the engine to connect enabled servers; engines that cannot ignore it. */
  status(cwd?: string, options?: { probe?: boolean }): Promise<unknown>;
  add(input: unknown, cwd?: string): Promise<unknown>;
  remove(name: string, cwd?: string, scope?: string): Promise<unknown>;
  setEnabled(name: string, enabled: boolean, cwd?: string, scope?: string): Promise<unknown>;
  trustProject(cwd: string): Promise<unknown>;
}

/** Prompt-template administration, when the engine keeps templates as files. */
export interface AgentPromptExtras {
  list(cwd: string): Promise<unknown>;
  save(input: unknown, cwd: string): Promise<unknown>;
  /** `source` names the storage surface (pi: always file); engines with more than one need it. */
  delete(name: string, scope: string, cwd: string, source?: string): Promise<unknown>;
}

/**
 * Provider sign-in administration, in the vocabulary the settings page needs.
 *
 * The payloads are `unknown` here on purpose: the DTO belongs to `@morse/protocol`
 * and the payload is produced by the engine's own config files. The host gates
 * on the presence of this port, not on a payload shape.
 */
export interface AgentProviderExtras {
  list(): Promise<unknown>;
  connect(input: unknown): Promise<unknown>;
  disconnect(input: unknown): Promise<unknown>;
  /**
   * The engine's own sign-in command for a subscription/OAuth provider, as an
   * argv the host can run in an interactive terminal. `undefined` means this
   * engine has no TUI login for that provider. The credential is written by the
   * engine, so Morse never handles it.
   */
  loginCommand?(input: unknown): Promise<unknown>;
  /** List the models a custom endpoint serves, best effort. */
  discover?(input: unknown): Promise<unknown>;
}

export interface AgentExtras {
  /** Managing provider sign-ins, when the engine keeps its own auth file. */
  providers?: AgentProviderExtras;
  /** Managing MCP servers, when the engine has a config to manage. */
  mcp?: AgentMcpExtras;
  /** Editing prompt templates, when the engine loads them from files. */
  prompts?: AgentPromptExtras;
  /**
   * Rewriting one config file so a later write can land — the panel's Fix action
   * beside a fixable `ConfigIssue`. The file is named by the issue, and the
   * engine refuses any `path` outside the config paths it resolves for
   * `fileId`/`scope`/`cwd`; a request for an arbitrary file is not a repair.
   * Answers a `ConfigMutation` the panel can render.
   */
  fix?(request: {
    fileId: string;
    /** Absolute path of the file, exactly as the issue reported it. */
    path: string;
    scope: ConfigScope;
    cwd?: string;
  }): Promise<unknown>;
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
