import type { AgentChildSessionRef } from "@morse/agent";

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
  const delegation = toolName === "task" || toolName === "subagent";
  const id =
    asString(record["childSessionID"]) ??
    asString(record["childID"]) ??
    (delegation
      ? (asString(record["sessionID"]) ?? asString(record["sessionId"]))
      : undefined);
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  const agent = asString(record["agent"]) ?? asString(record["subagentType"]);
  return { sessionId: id, ...(agent === undefined ? {} : { agent }) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
