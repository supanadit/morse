/** Sessions, projects and their usage counters — what the sidebar and the footer show. */

export interface WorkspaceInfo {
  cwd: string;
  name: string;
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

/** How full the model's context window is. */
export interface ContextUsage {
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

/**
 * Whole-session generation speed, measured by the host: pi reports no timing,
 * so the panel's numbers come from messages this host watched generate.
 */
export interface SessionSpeed {
  /** Output tokens over seconds spent generating, across every counted message. */
  avgTokensPerSecond: number;
  /** The fastest single counted message. */
  peakTokensPerSecond: number;
  /** The slowest single counted message. */
  slowestTokensPerSecond: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  messageCount: number;
  /**
   * The session this one was forked from, as its id (a session file path), when
   * pi recorded one. A child and its parent share a first message, so this is the
   * only thing that tells a fork apart from a session that happens to start the
   * same way — the frontend nests a child under its parent by it.
   */
  parentId?: string;
}

/**
 * Live state of one session the host is running right now (a hot agent
 * process). `session/list` is the persisted catalog; this is the subset that is
 * actually alive, so a frontend can show several sessions working at once
 * instead of pretending only the selected one exists.
 */
export interface SessionActivity {
  /** Registry key: the session id, or a synthetic key before a new session is persisted. */
  sessionKey: string;
  /** The agent is producing a response (thinking, tools or text). */
  streaming: boolean;
  /** The host is switching to/starting this session. */
  busy: boolean;
  agentReady: boolean;
  agentStarting: boolean;
  agentError?: string;
  /**
   * An extension dialog in this session is waiting for the reader. It is true
   * for a background conversation too, so the navigator can mark the tab that
   * is blocked instead of letting the agent wait without a visible cue.
   */
  needsInput?: boolean;
}

/** A project is a directory the agent has worked in (one pi session bucket). */
export interface ProjectSummary {
  path: string;
  name: string;
  sessionCount: number;
  lastUsedAt: number;
}

/**
 * How much of the machine this host exposes.
 *
 * `global` is the browser host: every project pi knows about.
 * `workspace` is VS Code, which is scoped to the folders the window has open
 * — no project switcher, only sessions inside those folders.
 */

/** What the host can do; the frontend adapts instead of guessing. */
