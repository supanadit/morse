import type { AgentChildSessionRef } from '@morse/agent';
import { asNonEmptyString, asRecord } from './guards.js';

/**
 * The session a tool call spawned, when the call delegated to one.
 *
 * OpenCode's `task` tool runs a subagent in a child session (each call its own
 * child; several children can run in parallel), and the server surfaces the
 * link in the tool's metadata or input rather than a dedicated event. Builds
 * have not settled one field name, so this probes the shapes seen in the wild:
 * dedicated `childSessionID`/`childID` keys first, then `sessionID`/`sessionId`
 * — but the generic session keys only for a delegation tool (`task`), where a
 * `sessionID` in the metadata can only mean the child, never the parent.
 *
 * Absent a recognizable field the link is simply omitted: the tool row still
 * renders, it just does not offer the child's transcript. This is the
 * engine-agnostic seam — pi-subagents' `subagent` tool maps through the same
 * probe in its own integration.
 */
export function childSessionOf(
  toolName: string,
  source: unknown,
): AgentChildSessionRef | undefined {
  const record = asRecord(source);
  if (record === undefined) {
    return undefined;
  }
  const delegation = toolName === 'task' || toolName === 'subagent';
  const id =
    asNonEmptyString(record['childSessionID']) ??
    asNonEmptyString(record['childID']) ??
    (delegation ? (asNonEmptyString(record['sessionID']) ?? asNonEmptyString(record['sessionId'])) : undefined);
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  const agent = asNonEmptyString(record['agent']) ?? asNonEmptyString(record['subagentType']);
  return { sessionId: id, ...(agent === undefined ? {} : { agent }) };
}

/**
 * The child a delegation tool's *result text* carries, when the metadata and
 * the input do not: builds that put the id only in the content mark it there —
 * `<subagent sessionID="ses_…" state="completed">`. Probed last, on the text
 * the row already shows, so it costs one regex only when the structured probes
 * missed. `source` is the delegation input, whose `agent` names the child the
 * way the tag itself rarely does.
 */
export function childSessionFromText(
  text: string | undefined,
  source?: unknown,
): AgentChildSessionRef | undefined {
  if (text === undefined) {
    return undefined;
  }
  const tag = /<subagent\b[^>]*>/.exec(text)?.[0];
  if (tag === undefined) {
    return undefined;
  }
  const sessionId = /\bsessionID="([^"]+)"/.exec(tag)?.[1];
  if (sessionId === undefined || sessionId.length === 0) {
    return undefined;
  }
  const agent =
    /\bagent="([^"]+)"/.exec(tag)?.[1] ??
    asNonEmptyString(asRecord(source)?.['agent']) ??
    asNonEmptyString(asRecord(source)?.['subagentType']);
  return { sessionId, ...(agent === undefined ? {} : { agent }) };
}
