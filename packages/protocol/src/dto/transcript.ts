/** Transcript items: the rows a frontend renders, and what a prompt carries. */
import type { NoticeLevel, ToolStatus, ToolResultDetails } from './primitives.js';

/**
 * A session a tool call spawned: the engine's own session id (the same id the
 * session catalog lists) and the agent that ran it, when the engine names one.
 * Mirrors `@morse/agent`'s `AgentChildSessionRef` by structure — the wire
 * contract stays dependency-free.
 */
export interface ChildSessionRef {
  sessionId: string;
  agent?: string;
}

export interface BaseTranscriptItem {
  id: string;
  at: number;
}

/**
 * An image attached to a prompt. Base64, without a `data:` prefix — pi accepts
 * it verbatim as `{type: 'image', data, mimeType}`. Stored on the user message
 * so the data survives in the chat, exactly like it does in pi sessions.
 */
export interface PromptImage {
  data: string;
  mimeType: string;
}

/**
 * A file (or an editor selection) pinned to a message as an attachment chip.
 * The agent is meant to read it — the wire mentions `@path[:start-end]`, never
 * the inlined content, so the prompt keeps the words the user actually typed.
 * An optional `note` (the pin's annotation) rides under the mention on the wire
 * as `> `-prefixed lines, one per line of the note.
 */
export interface ChatPin {
  path: string;
  startLine?: number;
  endLine?: number;
  /**
   * 1-based column of the first selected character, matching the editor's own
   * status bar (a tab counts as one). Present together with `endColumn`, and
   * only when `startLine` is present; absent for a whole-line pin and for a host
   * that does not capture columns.
   */
  startColumn?: number;
  /** 1-based column of the last selected character (the selection's end is exclusive). */
  endColumn?: number;
  /** How many UTF-16 characters the selection covers, line breaks included. */
  characters?: number;
  /**
   * The selected words, for a one-line selection only and capped so a huge
   * highlight cannot flood the prompt. Multi-line and whole-line pins carry no
   * excerpt.
   */
  text?: string;
  note?: string;
}

/**
 * A prompt handed back to the composer after a fork: the message the branch
 * re-opened, plus its attachments, so the user continues the new branch from
 * where they forked instead of retyping it. Sent as `composer/seed`.
 */
export interface ComposerSeed {
  text: string;
  images?: PromptImage[];
  pins?: ChatPin[];
}

export interface UserTranscriptItem extends BaseTranscriptItem {
  kind: 'user';
  text: string;
  /** Image attachments pinned to this message, rendered as thumbnails. */
  images?: PromptImage[];
  /** File/selection pins pinned to this message, rendered as chips. */
  pins?: ChatPin[];
}

export interface AssistantTranscriptItem extends BaseTranscriptItem {
  kind: 'assistant';
  text: string;
  thinking: string;
  streaming: boolean;
  model?: string;
}

export interface ToolTranscriptItem extends BaseTranscriptItem {
  kind: 'tool';
  name: string;
  title: string;
  status: ToolStatus;
  input?: string;
  output?: string;
  /**
   * The tool's structured result, when it returned one. A frontend probes this
   * by shape (see the task-list probe) instead of matching a tool by name, so
   * any conforming extension renders without a Morse change. Optional: most
   * tools return only text, and the JSON is omitted for them.
   */
  details?: ToolResultDetails;
  durationMs?: number;
  /**
   * The session this call spawned, when it delegated to one — a subagent run.
   * Presence is the whole contract: any engine or extension that spawns a
   * session links it here, and the frontend offers the child's transcript from
   * this row without knowing the tool's name. Optional: most tools spawn
   * nothing.
   */
  child?: ChildSessionRef;
}

export interface NoticeTranscriptItem extends BaseTranscriptItem {
  kind: 'notice';
  level: NoticeLevel;
  text: string;
}

/**
 * A compaction boundary. Everything before it was summarized into `summary`
 * (what the agent now carries as context); the transcript keeps the full
 * conversation and marks the point instead — like pi's own TUI — so a resumed
 * session does not silently shrink to the post-compaction tail.
 */
export interface CompactionTranscriptItem extends BaseTranscriptItem {
  kind: 'compaction';
  summary?: string;
  /** Approximate tokens that the summary folded away, when the agent reports it. */
  tokensBefore?: number;
}

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | NoticeTranscriptItem
  | CompactionTranscriptItem;
