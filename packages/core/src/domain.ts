/**
 * Domain layer: anemic data shapes, value objects and sentinel errors only.
 * No I/O, no ports, no framework imports (clean-architecture R2, R8).
 */

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';

export interface ModelRef {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  /** Provider cap on the response length, for the footer's output limit. */
  maxTokens?: number;
}

export type AgentCommandSource = 'extension' | 'prompt' | 'skill';

/** A command the agent exposes to the composer (pi `get_commands`). */
export interface AgentCommand {
  name: string;
  description?: string;
  source: AgentCommandSource;
  /**
   * Raw Markdown of a prompt template, for `source: 'prompt'` only. pi does not
   * send the body over RPC, so the adapter reads the file `get_commands` named
   * and the modal expands it here. Absent when the file could not be read.
   */
  template?: string;
}

/** An image attached to a prompt: base64 payload plus its media type. */
export interface PromptImage {
  /** Base64 data, without a `data:` URL prefix. */
  data: string;
  mimeType: string;
}

/** A file (or editor selection) pinned to a message as an attachment chip. */
export interface ChatPin {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Prompt tokens written into the provider's prompt cache. */
  cacheWriteTokens?: number;
  /** Reasoning tokens; a subset of `outputTokens`. */
  reasoningTokens?: number;
}

/** How full the model's context window is, straight from the agent. */
export interface ContextUsage {
  /** Tokens currently in context; `null` right after a compaction. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Message/step counts for the session, for the usage panel. */
export interface SessionCounts {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
}

export interface WorkspaceRef {
  cwd: string;
  name: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  messageCount: number;
}

/** A project is a directory the agent has worked in (one pi session bucket). */
export interface ProjectSummary {
  path: string;
  name: string;
  sessionCount: number;
  lastUsedAt: number;
}

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

export interface AgentSessionState {
  sessionId?: string;
  sessionTitle?: string;
  workspace: WorkspaceRef;
  model?: ModelRef;
  thinkingLevel: ThinkingLevel;
  availableModels: ModelRef[];
  availableThinkingLevels: ThinkingLevel[];
  /** Commands pi exposes (`get_commands`): extensions, templates, skills. */
  availableCommands: AgentCommand[];
  /**
   * Warnings about pi's own configuration (a prompt template it refused, say).
   * Optional: an agent backend with nothing to report leaves it out.
   */
  diagnostics?: AgentDiagnostic[];
  streaming: boolean;
  /** Cumulative session tokens (input/output/cache) reported by the agent. */
  usage?: TokenUsage;
  /** Tokens of the most recent assistant message, for the usage panel. */
  lastUsage?: TokenUsage;
  /** Cumulative session cost in USD, when the provider reports it. */
  costUsd?: number;
  contextUsage?: ContextUsage;
  counts?: SessionCounts;
}

/**
 * One already-finished exchange from a persisted session, so a resumed session
 * can show its history instead of an empty panel.
 */
/**
 * One entry of an agent's past conversation, normalised away from any transport.
 *
 * `tool` entries carry a finished tool call: a persisted session replays its
 * calls too, otherwise a resumed transcript would look like the agent did
 * nothing between two messages.
 */
export type AgentHistoryEntry =
  | {
      role: 'user' | 'assistant';
      text: string;
      thinking?: string;
      model?: string;
      /** Image attachments the user pinned to this message (user role). */
      images?: PromptImage[];
      /** File/selection pins attached to this message (user role). */
      pins?: ChatPin[];
      at?: number;
    }
  | {
      role: 'tool';
      /** Provider-side id, used to attach the matching tool result. */
      toolCallId: string;
      name: string;
      title: string;
      input?: string;
      output?: string;
      status: 'ok' | 'error';
      at?: number;
    }
  /**
   * A compaction boundary in the session's history: everything before it was
   * summarized into `summary` (that is the context the agent carries); the
   * transcript marks the point instead of hiding the folded messages.
   */
  | {
      role: 'compaction';
      summary: string;
      tokensBefore?: number;
      at?: number;
    };

/**
 * A past user message the agent can fork from: stable entry id plus the exact
 * text the model received. Forking re-parents the conversation before it, which
 * is how a frontend lets a user edit a prompt that already has an answer.
 */
export interface AgentForkMessage {
  entryId: string;
  text: string;
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/** The agent asking the user for input, normalised away from any transport. */
export type AgentInteractionRequest =
  | { requestId: string; kind: 'select'; title: string; message?: string; options: SelectOption[] }
  | { requestId: string; kind: 'confirm'; title: string; message: string; danger?: boolean }
  | { requestId: string; kind: 'input'; title: string; placeholder?: string; value?: string }
  | { requestId: string; kind: 'editor'; title: string; value?: string; language?: string };

export interface AgentInteractionResponse {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** Everything a host can observe from a running agent. */
export type AgentEvent =
  | { type: 'agent/ready'; at: number; state: AgentSessionState }
  | { type: 'agent/state'; at: number; state: AgentSessionState }
  | { type: 'agent/run-start'; at: number }
  | { type: 'agent/delta'; at: number; channel: 'text' | 'thinking'; delta: string }
  | { type: 'agent/message'; at: number; text: string; thinking: string }
  | {
      type: 'agent/tool-start';
      at: number;
      toolCallId: string;
      name: string;
      title: string;
      input?: string;
    }
  | {
      type: 'agent/tool-update';
      at: number;
      toolCallId: string;
      output?: string;
      status?: 'running' | 'ok' | 'error';
    }
  | {
      type: 'agent/tool-end';
      at: number;
      toolCallId: string;
      status: 'ok' | 'error';
      output?: string;
      durationMs?: number;
    }
  | { type: 'agent/run-end'; at: number; reason: 'settled' | 'aborted' | 'error'; error?: string }
  | { type: 'agent/interaction'; at: number; request: AgentInteractionRequest }
  | { type: 'agent/notice'; at: number; level: NoticeLevel; text: string }
  /**
   * A successful compaction finished while the session was live. The projector
   * records the boundary as its own marker row — so the transcript shows where
   * the agent's context was summarized, including after a reload replays this
   * warm transcript; a cold resume gets the same markers out of session
   * history instead.
   */
  | { type: 'agent/compaction'; at: number; summary: string; tokensBefore?: number }
  | { type: 'agent/fatal'; at: number; message: string; detail?: string };
