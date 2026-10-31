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

/** The most selected characters a pin quotes back to the agent. */
export const MAX_PIN_EXCERPT = 120;

/** A file (or editor selection) pinned to a message as an attachment chip. */
export interface ChatPin {
  path: string;
  startLine?: number;
  endLine?: number;
  /**
   * 1-based column of the first selected character, matching the editor's own
   * status bar (a tab counts as one). Present together with `endColumn`, and
   * only when `startLine` is present. Absent for a whole-line selection and for
   * a host that does not capture columns.
   */
  startColumn?: number;
  /**
   * 1-based column of the last selected character. An editor selection's end is
   * exclusive, so this is `end.character`, never `end.character + 1`.
   */
  endColumn?: number;
  /** How many UTF-16 characters the selection covers, line breaks included. */
  characters?: number;
  /**
   * The selected words themselves, for a one-line selection only, capped at
   * `MAX_PIN_EXCERPT` so a huge highlight cannot flood the prompt. Multi-line
   * and whole-line pins carry no excerpt; the agent reads the range instead.
   */
  text?: string;
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
 * Whole-session generation speed. pi keeps no clock, so its host times each
 * assistant message (`message_start` → `message_end`) and persists the totals
 * per session — a resumed session continues them from disk. OpenCode's engine
 * keeps the clock, so its adapter derives the totals from the stored message
 * times instead.
 */
export interface SessionSpeed {
  /** Output tokens over seconds spent generating, across every counted message. */
  avgTokensPerSecond: number;
  /** The fastest single counted message. */
  peakTokensPerSecond: number;
  /** The slowest single counted message. */
  slowestTokensPerSecond: number;
}
