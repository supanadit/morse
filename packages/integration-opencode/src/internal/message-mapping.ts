import type {
  AgentForkMessage,
  AgentHistoryEntry,
  ToolResultDetails,
} from "@morse/agent";
import { describeToolCall } from "./event-mapping.js";
import { childSessionOf } from "./child-session.js";

/**
 * OpenCode's stored messages → the harness contract's history entries.
 *
 * The message list is newest-first and mixes transcript content (`user`,
 * `assistant`, a completed `compaction`) with bookkeeping the server keeps in the
 * same stream (`idle`, `model-switched`, failed compactions, tool/shell rows some
 * versions persist). Only the former becomes a `AgentHistoryEntry`: a bookkeeping
 * row must not masquerade as a message, and paging must continue past a whole page
 * of them rather than claim the conversation ended.
 *
 * One assistant message can hold several entries: its prose/thinking is one
 * entry, and each `tool` content part is another, in the order the model produced
 * them — which is exactly how the live event stream rendered the same turn.
 */

/** The parts of a `Session.Message.Info` this adapter reads. */
export interface ApiMessage {
  id: string;
  type: string;
  time?: { created?: number; completed?: number };
  text?: string;
  content?: unknown;
  status?: string;
  summary?: string;
  model?: { id?: string; providerID?: string };
  tokens?: unknown;
  error?: unknown;
}

/** One assistant content part (`text`, `reasoning`, `tool`, …). */
interface ApiContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  state?: {
    status?: string;
    input?: unknown;
    content?: unknown;
    metadata?: unknown;
  };
}

/** The entries one stored message stands for, in conversation order. */
export function messageEntries(message: ApiMessage): AgentHistoryEntry[] {
  const at = message.time?.created;
  switch (message.type) {
    case "user": {
      const text = message.text ?? "";
      // Attachments-only prompts still count as prompts the reader can fork.
      return [{ role: "user", text, ...(at === undefined ? {} : { at }) }];
    }
    case "assistant":
      return assistantEntries(message, at);
    case "compaction": {
      // A failed compaction is a bookkeeping row ("Nothing to compact yet"), not
      // a boundary in the conversation.
      if (
        message.status !== "completed" ||
        typeof message.summary !== "string" ||
        message.summary.length === 0
      ) {
        return [];
      }
      const tokensBefore = asNumber(asRecord(message.tokens)?.["input"]);
      return [
        {
          role: "compaction",
          summary: message.summary,
          ...(tokensBefore === undefined ? {} : { tokensBefore }),
          ...(at === undefined ? {} : { at }),
        },
      ];
    }
    default:
      // `idle`, `model-switched`, `shell`, `skill`, `system`, `synthetic`, … are
      // the server's own bookkeeping.
      return [];
  }
}

function assistantEntries(
  message: ApiMessage,
  at: number | undefined,
): AgentHistoryEntry[] {
  const parts = asArray(message.content) ?? [];
  const text = parts
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
  const thinking = parts
    .map((part) =>
      part.type === "reasoning" || part.type === "thinking"
        ? (part.thinking ?? part.text ?? "")
        : "",
    )
    .join("");
  const entries: AgentHistoryEntry[] = [];
  if (text.length > 0 || thinking.length > 0) {
    entries.push({
      role: "assistant",
      text,
      ...(thinking.length === 0 ? {} : { thinking }),
      ...(message.model?.id === undefined
        ? {}
        : {
            model:
              `${message.model.providerID ?? ""}/${message.model.id}`.replace(
                /^\//,
                "",
              ),
          }),
      ...(at === undefined ? {} : { at }),
    });
  }
  for (const part of parts) {
    if (part.type !== "tool" || part.id === undefined) {
      continue;
    }
    const name = part.name ?? "tool";
    const state = part.state;
    const input = asRecord(state?.input);
    const output = contentToText(state?.content);
    const details = asRecord(state?.metadata);
    entries.push({
      role: "tool",
      toolCallId: part.id,
      name,
      title: describeToolCall(name, input),
      ...(input === undefined ? {} : { input: safeStringify(input) }),
      ...(output === undefined ? {} : { output }),
      status: toolStatus(state?.status),
      ...(details === undefined
        ? {}
        : { details: details as ToolResultDetails }),
      ...(childSessionOf(name, state?.metadata) ??
        childSessionOf(name, input) ??
        {}),
      ...(at === undefined ? {} : { at }),
    });
  }
  return entries;
}

/** The history entries for a page of stored messages, preserving their order. */
export function toHistoryEntries(
  messages: readonly ApiMessage[],
): AgentHistoryEntry[] {
  return messages.flatMap(messageEntries);
}

/**
 * The user prompts a fork can target, in conversation order.
 *
 * The newest-first page is reversed once for the whole list, so the caller sees
 * prompts oldest first — the order a menu of "edit that message" expects.
 */
export function toForkMessages(
  messages: readonly ApiMessage[],
): AgentForkMessage[] {
  return messages
    .filter((message) => message.type === "user")
    .reverse()
    .map((message) => ({ entryId: message.id, text: message.text ?? "" }));
}

function toolStatus(status: string | undefined): "ok" | "error" {
  return status === "error" || status === "failed" ? "error" : "ok";
}

/** `content: [{type:'text',text}]` → its text, when a tool result carries one. */
function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  const parts = asArray(content);
  if (parts === undefined) {
    return undefined;
  }
  const text = parts
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
  return text.length > 0 ? text : undefined;
}

function asArray(value: unknown): ApiContentPart[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (part): part is ApiContentPart => part !== null && typeof part === "object",
  ) as ApiContentPart[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
