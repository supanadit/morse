/** The whole panel as one value: connection, session, agent state, paging and the layout. */
/**
 * Machine-readable reason the agent backend is not running. Hosts only name what
 * they can name, so a frontend must still render `agentError` itself — the code is
 * there to pick the right *help*, not to replace the message.
 */
export type AgentErrorCode =
  /** `pi` could not be resolved: not installed, or the configured path is wrong. */
  | 'agent-unavailable'
  /** `pi` answered with something the adapter could not understand. */
  | 'agent-protocol';

import type { ThinkingLevel, NoticeLevel } from './primitives.js';
import type { ModelOption, CommandOption, ModeOption } from './model.js';
import type { WorkspaceInfo, TokenUsage, ContextUsage, SessionCounts, SessionSpeed } from './session.js';

export interface AgentFailure {
  code?: AgentErrorCode;
  /** Shell command that installs what is missing, when the adapter knows it. */
  install?: string;
  /** Host-specific next step: which setting or environment variable to look at. */
  hint?: string;
}

/**
 * A problem the agent reported loading its own configuration — a prompt
 * template pi refused, say. The panel shows one warning row and lists these
 * behind a click; they are never written into the conversation.
 */
export interface AgentDiagnosticMessage {
  level: NoticeLevel;
  text: string;
}

/**
 * A block of text an extension asked pi's TUI to show (pi `ctx.ui.setWidget`).
 * RPC forwards string lines only, so a frontend can render it as text, not as a
 * terminal component.
 */
export interface WidgetBlock {
  key: string;
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

/** A footer status line an extension set (pi `ctx.ui.setStatus`). */
export interface StatusLine {
  key: string;
  text: string;
}

export interface SessionViewState {
  sessionId?: string;
  sessionTitle?: string;
  workspace: WorkspaceInfo;
  /**
   * True only for the intentional empty panel before the first prompt. A
   * frontend uses it to offer choices that only make sense for a new session,
   * such as the engine; it is not "no state has arrived yet".
   */
  draft?: boolean;
  /** The engine the draft chose; absent means the host's default. */
  engine?: string;
  model?: ModelOption;
  thinkingLevel: ThinkingLevel;
  availableModels: ModelOption[];
  availableThinkingLevels: ThinkingLevel[];
  /** Commands pi exposes (`get_commands`): extensions, templates, skills. */
  availableCommands: CommandOption[];
  /** The named way of working this session is in, when the harness offers any. */
  mode?: string;
  /** The modes the harness offers, with its default marked. */
  availableModes?: ModeOption[];
  /**
   * True while the draft is re-reading a newly chosen engine's catalogs, so the
   * composer can hold Send instead of starting a session against a half-read
   * catalog.
   */
  loadingEngine?: boolean;
  streaming: boolean;
  busy: boolean;
  /** Cumulative session tokens (input/output/cache) reported by the agent. */
  usage?: TokenUsage;
  /** Tokens of the most recent assistant message. */
  lastUsage?: TokenUsage;
  /** Cumulative session cost in USD, when the provider reports it. */
  costUsd?: number;
  contextUsage?: ContextUsage;
  counts?: SessionCounts;
  /** Whole-session generation speed, measured by the host (pi reports none). */
  speed?: SessionSpeed;
  /** False when the agent backend (the `pi` binary) could not be started. */
  agentReady: boolean;
  /** True while the host is spawning/attaching the agent, so the UI does not
   * show an error during a normal (slow) start. */
  agentStarting: boolean;
  agentError?: string;
  /**
   * What `agentError` means and what to do about it. Optional: a host that could
   * not classify the failure (a process that exited, say) sends the message only,
   * and the frontend falls back to generic wording.
   */
  agentFailure?: AgentFailure;
  /** True when older transcript entries can still be loaded from the session. */
  hasOlderHistory?: boolean;
  /** True while the host is fetching the previous history page. */
  loadingOlderHistory?: boolean;
  /**
   * True while the host is re-reading the thinking levels of the model the
   * reader just picked. pi scopes the levels to the *current* model, so they
   * can only be re-read after the switch (over RPC for a live session, by
   * re-probing pi on a draft) — the picker shows this instead of the previous
   * model's list meanwhile.
   */
  loadingThinkingLevels?: boolean;
  /**
   * Configuration warnings from the agent itself, as a row above the
   * conversation rather than lines inside it. Optional and usually absent.
   */
  diagnostics?: AgentDiagnosticMessage[];
  /**
   * Text blocks extensions asked pi's TUI to show. Optional: present only while
   * an extension has one set. A frontend renders them as text, per session.
   */
  widgets?: WidgetBlock[];
  /** Footer status lines extensions set. Optional, as above. */
  statuses?: StatusLine[];
}
