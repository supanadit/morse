/**
 * The host controller's pure mappings: transcript rows, edit anchors, terminal
 * geometry and the failure shapes a frontend can act on.
 */
import type { AgentHistoryEntry, AgentUserMessage, WorkspaceRef } from '@morse/agent';
import type {
  AgentErrorCode,
  AgentFailure,
  TranscriptItem,
  UserTranscriptItem,
} from '@morse/protocol';
import { AgentUnavailableError, MorseError } from '@morse/system';
import { describeError } from '../errors.js';

export function workspaceOf(path: string): WorkspaceRef {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return { cwd: path, name: parts.at(-1) ?? path };
}

export function insideRoots(path: string, roots: string[]): boolean {
  return roots.some(
    (root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`),
  );
}

/** Domain history -> transcript items (presentation mapping stays in this layer). */
export function historyItems(key: string, entries: AgentHistoryEntry[], page: number): TranscriptItem[] {
  return entries.map((entry, index): TranscriptItem => {
    const id = `${key}#history-${page}-${index}`;
    const at = entry.at ?? 0;
    if (entry.role === 'user') {
      return {
        kind: 'user',
        id,
        at,
        text: entry.text,
        ...(entry.images ? { images: entry.images } : {}),
        ...(entry.pins ? { pins: entry.pins } : {}),
      };
    }
    if (entry.role === 'tool') {
      return {
        kind: 'tool',
        id,
        at,
        name: entry.name,
        title: entry.title,
        status: entry.status,
        input: entry.input,
        output: entry.output,
        ...(entry.details !== undefined ? { details: entry.details } : {}),
        ...(entry.childSession !== undefined ? { child: entry.childSession } : {}),
      };
    }
    if (entry.role === 'compaction') {
      // A marker row, not a message: the transcript keeps every folded entry —
      // the divider says where the agent's context was reset, not where history
      // ends ("Start of conversation" belongs to the real beginning again).
      return {
        kind: 'compaction',
        id,
        at,
        summary: entry.summary,
        ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
      };
    }
    return {
      kind: 'assistant',
      id,
      at,
      text: entry.text,
      thinking: entry.thinking ?? '',
      streaming: false,
      model: entry.model,
    };
  });
}

/**
 * Maps a transcript row to the engine entry an edit or fork cuts at.
 *
 * Both lists are total: the engine lists every user message and the transcript
 * keeps a row for each, a text-less one (an image-only prompt) included. Counting
 * the same distance from the end keeps the two lists aligned even when an older
 * history page is still unloaded.
 */
export function entryIdForEdit(
  items: TranscriptItem[],
  itemId: string,
  userMessages: AgentUserMessage[],
): string | undefined {
  const userItems = items.filter((item): item is UserTranscriptItem => item.kind === 'user');
  const index = userItems.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return undefined;
  }
  // Count from the end so a partially loaded transcript still lines up: both
  // lists are total now, so the offset is exact.
  const position = userMessages.length - (userItems.length - index);
  return position >= 0 ? userMessages[position]?.entryId : undefined;
}


/** Terminal geometry the wire named: a positive integer, or the default. */
export function clampGeometry(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

/** A terminal that could not open says why, the same way a command failure does. */
export function describeTerminalError(error: unknown): string {
  return error instanceof MorseError ? error.message : describeError(error);
}

/**
 * The machine-readable half of a failed start. Only the codes a frontend has help
 * for cross the wire; everything else keeps its message and the host's hint — a
 * frontend that guessed would offer the wrong remedy.
 */
export function describeAgentFailure(error: unknown, hint: string | undefined): AgentFailure | undefined {
  const code = agentErrorCode(error);
  const install = error instanceof AgentUnavailableError ? error.remedy?.install : undefined;
  const failure: AgentFailure = {
    ...(code ? { code } : {}),
    ...(install ? { install } : {}),
    ...(hint ? { hint } : {}),
  };
  return Object.keys(failure).length > 0 ? failure : undefined;
}

function agentErrorCode(error: unknown): AgentErrorCode | undefined {
  if (!(error instanceof MorseError)) {
    return undefined;
  }
  // `MorseError.code` is a plain string; only the two the UI can help with pass.
  return error.code === 'agent-unavailable' || error.code === 'agent-protocol'
    ? error.code
    : undefined;
}

/** The host's next step without a code: a dead process, not a resolution failure. */
export function hintOnly(hint: string | undefined): AgentFailure | undefined {
  return hint ? { hint } : undefined;
}
