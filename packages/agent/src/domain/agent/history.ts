/**
 * One entry of an agent's past conversation, normalised away from any transport.
 *
 * Shapes only — no I/O, no ports, no framework imports (R2/R8).
 */

import type { ChatPin, PromptImage } from '../usage.js';
import type { ToolResultDetails } from './state.js';

/**
 * The shape every history entry shares: which kind of entry it is, and when it
 * happened (absent on an entry a persisted session did not timestamp).
 *
 * A base interface each entry extends, so an entry has a name a caller can write
 * down. `role` stays the discriminant; the union at the end of this block narrows
 * exactly as it did when the variants were inline object literals.
 */
export interface AgentHistoryEntryBase {
  role: 'user' | 'assistant' | 'tool' | 'compaction';
  at?: number;
}

/**
 * A message the user or the agent sent. Both roles share the shape: an assistant
 * turn can carry `thinking` and the model that produced it, a user turn can carry
 * the images and pins they attached.
 */
export interface AgentMessageEntry extends AgentHistoryEntryBase {
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  model?: string;
  /** Image attachments the user pinned to this message (user role). */
  images?: PromptImage[];
  /** File/selection pins attached to this message (user role). */
  pins?: ChatPin[];
}

/**
 * A finished tool call: a persisted session replays its calls too, otherwise a
 * resumed transcript would look like the agent did nothing between two messages.
 */
export interface AgentToolEntry extends AgentHistoryEntryBase {
  role: 'tool';
  /** Provider-side id, used to attach the matching tool result. */
  toolCallId: string;
  name: string;
  title: string;
  input?: string;
  output?: string;
  status: 'ok' | 'error';
  /** The tool's structured result, when it returned one (see `agent/tool-end`). */
  details?: ToolResultDetails;
}

/**
 * A compaction boundary in the session's history: everything before it was
 * summarized into `summary` (that is the context the agent carries); the
 * transcript marks the point instead of hiding the folded messages.
 */
export interface AgentCompactionEntry extends AgentHistoryEntryBase {
  role: 'compaction';
  summary: string;
  tokensBefore?: number;
}

/** One entry of an agent's past conversation, normalised away from any transport. */
export type AgentHistoryEntry =
  | AgentMessageEntry
  | AgentToolEntry
  | AgentCompactionEntry;

