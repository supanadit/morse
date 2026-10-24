/**
 * What the user attaches to a prompt, and what the agent reports about the work
 * it did: token/context counters and the whole-session speed Morse measures
 * itself because pi keeps no clock.
 *
 * Shapes only — no I/O, no ports, no framework imports (R2/R8).
 */

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
  /**
   * The pin's annotation, the user's own words about this range. On the wire it
   * rides under the mention line as `> `-prefixed lines (one per note line), so
   * a pin without a note is byte-identical to the pre-annotation prompt and old
   * sessions keep rendering untouched.
   */
  note?: string;
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

/**
 * Whole-session generation speed. pi keeps no clock, so the host times each
 * assistant message (`message_start` → `message_end`) and keeps these totals
 * per session — a resumed session continues them from disk.
 */
export interface SessionSpeed {
  /** Output tokens over seconds spent generating, across every counted message. */
  avgTokensPerSecond: number;
  /** The fastest single counted message. */
  peakTokensPerSecond: number;
  /** The slowest single counted message. */
  slowestTokensPerSecond: number;
}
