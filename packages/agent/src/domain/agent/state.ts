/**
 * What a running agent reports about itself: the observable session state and the
 * blocks an extension can put on the screen.
 *
 * Shapes only — no I/O, no ports, no framework imports (R2/R8).
 */

import type { ContextUsage, SessionCounts, SessionSpeed, TokenUsage } from '../usage.js';
import type { AgentCommand, ModelRef, NoticeLevel, ThinkingLevel } from '../model.js';
import type { AgentMode } from './mode.js';
import type { WorkspaceRef } from '../workspace.js';

/**
 * A problem the agent's own resource loading reported, or Morse found while
 * reading a resource the agent refuses. Carried on the session state (not an
 * event) because it is known the moment the process starts — before the host
 * has subscribed — and must reach the transcript anyway.
 */
export interface AgentDiagnostic {
  /** Stable identity, so a repeated scan does not duplicate its notice. */
  key: string;
  level: NoticeLevel;
  text: string;
}

/**
 * A block of text an extension asked the TUI to show (pi `ctx.ui.setWidget`).
 * RPC mode forwards only string lines, never component factories, so a frontend
 * can render it but not an arbitrary terminal component.
 */
export interface AgentWidget {
  /** The extension's own key: a later `setWidget` with the same key replaces it. */
  key: string;
  lines: string[];
  /** Where pi would place it relative to the editor; kept so a host can order it. */
  placement: 'aboveEditor' | 'belowEditor';
}

/** A footer status line an extension set (pi `ctx.ui.setStatus`). */
export interface AgentStatus {
  /** A later `setStatus` with the same key replaces it. */
  key: string;
  text: string;
}

/** A JSON value as it arrives from pi — what structured tool data can be. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The structured result a tool returned (pi `AgentToolResult.details`).
 *
 * Deliberately an open JSON object: Morse carries it verbatim and a frontend
 * probes its *shape* to decide whether it can render it (a task list, say),
 * rather than matching an extension by name. Any tool that returns a
 * recognizable object is therefore renderable with no Morse change and no
 * plugin registry.
 */
export type ToolResultDetails = { [key: string]: JsonValue };

export interface AgentSessionState {
  sessionId?: string;
  /**
   * What the engine calls this session (OpenCode's `ses_…`, pi's UUID), so a
   * reader can line it up with the engine's own CLI. Once a session is recorded,
   * `sessionId` is re-keyed to Morse's derived id and this keeps the engine's.
   * An adapter sets it itself when the key it identifies sessions by is not
   * that id (pi keys by session file); otherwise the router stamps it when it
   * re-keys. Absent while `sessionId` is still the engine's.
   */
  engineSessionId?: string;
  sessionTitle?: string;
  workspace: WorkspaceRef;
  model?: ModelRef;
  thinkingLevel: ThinkingLevel;
  availableModels: ModelRef[];
  availableThinkingLevels: ThinkingLevel[];
  /**
   * The named way of working this session is in, when the harness offers any.
   * Optional: a harness without modes (pi today) leaves it out.
   */
  mode?: string;
  /** The modes this harness offers, with the harness's default marked. */
  availableModes?: AgentMode[];
  /** Commands pi exposes (`get_commands`): extensions, templates, skills. */
  availableCommands: AgentCommand[];
  /**
   * Warnings about pi's own configuration (a prompt template it refused, say).
   * Optional: an agent backend with nothing to report leaves it out.
   */
  diagnostics?: AgentDiagnostic[];
  /**
   * Text blocks extensions asked the TUI to show (pi `setWidget`). Optional:
   * present only while an extension has one set for this session.
   */
  widgets?: AgentWidget[];
  /** Footer status lines extensions set (pi `setStatus`). Optional, as above. */
  statuses?: AgentStatus[];
  streaming: boolean;
  /** Cumulative session tokens (input/output/cache) reported by the agent. */
  usage?: TokenUsage;
  /** Tokens of the most recent assistant message, for the usage panel. */
  lastUsage?: TokenUsage;
  /** Cumulative session cost in USD, when the provider reports it. */
  costUsd?: number;
  contextUsage?: ContextUsage;
  counts?: SessionCounts;
  /** Whole-session generation speed: host-timed for pi, from OpenCode's stored message times. */
  speed?: SessionSpeed;
}

