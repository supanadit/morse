/**
 * Everything a host can observe from a running agent: one interface per event,
 * sharing `AgentEventBase`.
 *
 * Shapes only — no I/O, no ports, no framework imports (R2/R8).
 */

import type { NoticeLevel } from '../model.js';
import type { AgentInteractionRequest } from './interaction.js';
import type { AgentSessionState, ToolResultDetails } from './state.js';

/**
 * The shape every agent event shares: the type discriminant, and when it happened.
 *
 * A base *interface* that each event extends, rather than a union of inline object
 * literals, so a reader can name one event (`AgentToolEndEvent`) without copying
 * six lines out of a union. The union below is still what a consumer switches on:
 * TypeScript narrows an interface union exactly as well as an inline one, so
 * exhaustiveness checks and `switch (event.type)` are unchanged.
 *
 * `type` stays the discriminant on every derived event; nothing else inherits from
 * `AgentEventBase` that is not an event.
 */
export interface AgentEventBase {
  /** Which event this is. Every event declares its own literal. */
  type: `agent/${string}`;
  /** Epoch milliseconds, from the emitting session's own clock. */
  at: number;
}

/** The agent finished starting and reported its first state. */
export interface AgentReadyEvent extends AgentEventBase {
  type: 'agent/ready';
  state: AgentSessionState;
}

/** The agent's observable state changed (model, streaming, usage, …). */
export interface AgentStateEvent extends AgentEventBase {
  type: 'agent/state';
  state: AgentSessionState;
}

/** A turn started: the agent is now working on the prompt it was given. */
export interface AgentRunStartEvent extends AgentEventBase {
  type: 'agent/run-start';
}

/** A streamed fragment of text or thinking, appended to the current message. */
export interface AgentDeltaEvent extends AgentEventBase {
  type: 'agent/delta';
  channel: 'text' | 'thinking';
  delta: string;
}

/** One finished assistant message, as a whole rather than as deltas. */
export interface AgentMessageEvent extends AgentEventBase {
  type: 'agent/message';
  text: string;
  thinking: string;
}

/** The agent began calling a tool. */
export interface AgentToolStartEvent extends AgentEventBase {
  type: 'agent/tool-start';
  toolCallId: string;
  name: string;
  title: string;
  input?: string;
}

/** A tool call reported intermediate output or a new status. */
export interface AgentToolUpdateEvent extends AgentEventBase {
  type: 'agent/tool-update';
  toolCallId: string;
  output?: string;
  status?: 'running' | 'ok' | 'error';
}

/** A tool call finished. */
export interface AgentToolEndEvent extends AgentEventBase {
  type: 'agent/tool-end';
  toolCallId: string;
  status: 'ok' | 'error';
  output?: string;
  /**
   * The tool's structured result (pi `AgentToolResult.details`), carried through
   * verbatim for a frontend to inspect. Morse never interprets it — a renderer
   * probes the *shape* (see the UI probe), so any extension's structured output
   * can light up without Morse knowing its name.
   */
  details?: ToolResultDetails;
  durationMs?: number;
}

/** The turn ended, with the reason it ended. */
export interface AgentRunEndEvent extends AgentEventBase {
  type: 'agent/run-end';
  reason: 'settled' | 'aborted' | 'error';
  error?: string;
}

/** The agent is asking the user for input. */
export interface AgentInteractionEvent extends AgentEventBase {
  type: 'agent/interaction';
  request: AgentInteractionRequest;
}

/** Something the reader should see, not as transcript content. */
export interface AgentNoticeEvent extends AgentEventBase {
  type: 'agent/notice';
  level: NoticeLevel;
  text: string;
}

/**
 * A successful compaction finished while the session was live. The projector
 * records the boundary as its own marker row — so the transcript shows where the
 * agent's context was summarized, including after a reload replays this warm
 * transcript; a cold resume gets the same markers out of session history instead.
 */
export interface AgentCompactionEvent extends AgentEventBase {
  type: 'agent/compaction';
  summary: string;
  tokensBefore?: number;
}

/** The agent process stopped or unrecoverably failed. */
export interface AgentFatalEvent extends AgentEventBase {
  type: 'agent/fatal';
  message: string;
  detail?: string;
}

/** Everything a host can observe from a running agent. */
export type AgentEvent =
  | AgentReadyEvent
  | AgentStateEvent
  | AgentRunStartEvent
  | AgentDeltaEvent
  | AgentMessageEvent
  | AgentToolStartEvent
  | AgentToolUpdateEvent
  | AgentToolEndEvent
  | AgentRunEndEvent
  | AgentInteractionEvent
  | AgentNoticeEvent
  | AgentCompactionEvent
  | AgentFatalEvent;
