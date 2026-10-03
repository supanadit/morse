import type {
  AgentEvent,
  AgentHistoryEntry,
  AgentSessionState,
  ChatPin,
  NoticeLevel,
  PromptImage,
  TokenUsage,
} from '@morse/core';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  type RpcAssistantMessageEvent,
  type RpcMessage,
  type RpcRecord,
  type RpcSessionStatsData,
  type RpcUsage,
} from './internal/rpc-types.js';

export interface MappedRecord {
  events: AgentEvent[];
  state?: Partial<AgentSessionState>;
}

/**
 * Pure mapping from pi session events (docs/json.md) to Morse domain events.
 * No subprocess, no clock: the caller injects `now`, which keeps it trivially
 * testable and shared by every pi transport.
 */
export function mapSessionEvent(record: RpcRecord, now: () => number): MappedRecord {
  switch (record.type) {
    case 'agent_start':
      return { events: [{ type: 'agent/run-start', at: now() }], state: { streaming: true } };
    case 'message_update':
      return mapMessageUpdate(record, now);
    case 'message_end':
      return mapMessageEnd(record, now);
    case 'tool_execution_start':
      return mapToolStart(record, now);
    case 'tool_execution_update':
      return mapToolUpdate(record, now);
    case 'tool_execution_end':
      return mapToolEnd(record, now);
    case 'compaction_start':
      return { events: [notice('info', 'Compacting the conversation context…', now)] };
    case 'compaction_end':
      return mapCompactionEnd(record, now);
    case 'auto_retry_start': {
      const attempt = numberField(record, 'attempt');
      const max = numberField(record, 'maxAttempts');
      const reason = stringField(record, 'errorMessage');
      const label = attempt && max ? ` (attempt ${attempt}/${max})` : '';
      return { events: [notice('warn', `Retrying${label}: ${reason ?? 'provider error'}`, now)] };
    }
    case 'auto_retry_end':
      return record['success'] === true
        ? { events: [] }
        : {
            events: [
              notice('error', stringField(record, 'finalError') ?? 'Retries exhausted.', now),
            ],
          };
    case 'extension_error':
      return {
        events: [
          notice(
            'error',
            `pi extension failed: ${stringField(record, 'error') ?? 'unknown error'}`,
            now,
          ),
        ],
      };
    default:
      return { events: [] };
  }
}

/**
 * One entry of pi's session tree (`get_entries`): messages interleaved with
 * compaction/branch-summary markers. Unlike `get_messages`, this carries the
 * FULL history pre-dating compaction, so a resumed session can show the whole
 * conversation with the compacted span marked instead of hidden.
 */
export function toEntryHistory(entries: readonly unknown[]): AgentHistoryEntry[] {
  const history: AgentHistoryEntry[] = [];
  /** Tool entries by provider call id, so the result can fill in its output. */
  const toolEntries = new Map<string, Extract<AgentHistoryEntry, { role: 'tool' }>>();

  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) {
      continue;
    }
    switch (asString(entry['type'])) {
      case 'message': {
        const message = asRecord(entry['message']);
        if (message) {
          collectMessage(message, history, toolEntries);
        }
        break;
      }
      case 'compaction': {
        const at = entryTimestamp(entry['timestamp']);
        history.push({
          role: 'compaction',
          summary: asString(entry['summary']) ?? '',
          tokensBefore: asNumber(entry['tokensBefore']),
          ...(at !== undefined ? { at } : {}),
        });
        break;
      }
      case 'branch_summary': {
        const summary = asString(entry['summary']);
        if (!summary) {
          break;
        }
        const at = entryTimestamp(entry['timestamp']);
        history.push({
          role: 'user',
          text: `*The conversation briefly explored another branch and returned with this summary:*

${summary}`,
          ...(at !== undefined ? { at } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  return history;
}

/** A flat message list (`get_messages`) seen as entries, keeping the old shape. */
export function toHistory(messages: readonly unknown[]): AgentHistoryEntry[] {
  return toEntryHistory(
    messages.map((message) => ({ type: 'message', message })),
  );
}

/**
 * The branch the leaf entry sits on, keeping append order: walking back through
 * `parentId` from the leaf drops abandoned branches (renamed/re-edited paths)
 * while the full pre-compaction history stays in. When the leaf (or its chain)
 * is unresolvable, everything is passed through — showing more beats hiding a
 * whole conversation behind a format quirk.
 */
export function activePathEntries(
  data: { entries?: unknown[]; leafId?: unknown } | undefined,
): unknown[] {
  const records = (data?.entries ?? []).map(asRecord).filter(isDefined);
  const leafId = asString(data?.leafId);
  if (!leafId) {
    return records;
  }
  const byId = new Map(
    records
      .map((record) => [asString(record['id']), record] as const)
      .filter((pair): pair is [string, Record<string, unknown>] => pair[0] !== undefined),
  );
  if (!byId.has(leafId)) {
    return records;
  }
  const keep = new Set<string>([leafId]);
  let cursor: string | null = leafId;
  while (cursor !== null) {
    const parent = byId.get(cursor);
    const parentId = parent ? (asString(parent['parentId']) ?? null) : null;
    if (parentId === null || keep.has(parentId)) {
      break;
    }
    keep.add(parentId);
    cursor = parentId;
  }
  return records.filter((record) => keep.has(asString(record['id']) ?? ''));
}

function collectMessage(
  message: Record<string, unknown>,
  entries: AgentHistoryEntry[],
  toolEntries: Map<string, Extract<AgentHistoryEntry, { role: 'tool' }>>,
): void {
  const role = asString(message['role']);

  if (role === 'toolResult') {
    const toolCallId = asString(message['toolCallId']);
    const entry = toolCallId ? toolEntries.get(toolCallId) : undefined;
    if (entry) {
      const output = contentToText(message['content']);
      if (output.length > 0) {
        entry.output = output;
      }
      entry.status = message['isError'] === true ? 'error' : 'ok';
    }
    return;
  }

  if (role !== 'user' && role !== 'assistant') {
    return;
  }

  let text = contentToText(message['content']);
  const thinking = contentToThinking(message['content']);
  let pins: ChatPin[] | undefined;
  const images = role === 'user' ? contentToImages(message['content']) : [];
  if (role === 'user') {
    // The transcript keeps what the user actually typed: `@mention` lines
    // Morse appended for pins come back out and render as attachment chips
    // again, instead of a blob of mentions inside the message.
    const split = splitTrailingMentions(text);
    text = split.text;
    pins = split.pins.length > 0 ? split.pins : undefined;
  }
  if (
    text.length > 0 ||
    thinking.length > 0 ||
    (pins !== undefined && pins.length > 0) ||
    images.length > 0
  ) {
    entries.push({
      role,
      text,
      thinking: thinking.length > 0 ? thinking : undefined,
      ...(images.length > 0 ? { images } : {}),
      ...(pins !== undefined ? { pins } : {}),
      model: asString(message['model']),
      at: asNumber(message['timestamp']),
    });
  }

  if (role === 'assistant') {
    for (const call of toolCallsOf(message['content'])) {
      const entry: Extract<AgentHistoryEntry, { role: 'tool' }> = {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        title: describeToolCall(call.name, call.arguments),
        input: safeStringify(call.arguments),
        status: 'ok',
        at: asNumber(message['timestamp']),
      };
      toolEntries.set(call.id, entry);
      entries.push(entry);
    }
  }
}

interface HistoryToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | undefined;
}

function toolCallsOf(content: unknown): HistoryToolCall[] {
  const blocks = asArray(content);
  if (!blocks) {
    return [];
  }
  const calls: HistoryToolCall[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record || asString(record['type']) !== 'toolCall') {
      continue;
    }
    const name = asString(record['name']);
    if (!name) {
      continue;
    }
    calls.push({
      id: asString(record['id']) ?? `call-${calls.length}`,
      name,
      arguments: asRecord(record['arguments']),
    });
  }
  return calls;
}

function mapMessageUpdate(record: RpcRecord, now: () => number): MappedRecord {
  const assistant = asRecord(record['assistantMessageEvent']) as RpcAssistantMessageEvent | undefined;
  if (!assistant) {
    return { events: [] };
  }
  if (assistant.type === 'text_delta' && assistant.delta) {
    return {
      events: [{ type: 'agent/delta', at: now(), channel: 'text', delta: assistant.delta }],
    };
  }
  if (assistant.type === 'thinking_delta' && assistant.delta) {
    return {
      events: [{ type: 'agent/delta', at: now(), channel: 'thinking', delta: assistant.delta }],
    };
  }
  return { events: [] };
}

function mapMessageEnd(record: RpcRecord, now: () => number): MappedRecord {
  const message = asRecord(record['message']) as RpcMessage | undefined;
  if (!message || message.role !== 'assistant') {
    return { events: [] };
  }

  const events: AgentEvent[] = [];
  // Deliberately no `streaming: false` here. A run contains many turns
  // (thinking -> tool -> thinking -> tool), so the flag means "the agent is
  // working", exactly like pi's own `isStreaming`; only `agent_settled` and a
  // fatal error end it. Flipping it per message made every progress indicator
  // (and the process timeline) blink once per step.
  const state: Partial<AgentSessionState> = {};
  const usage = toUsage(message.usage);
  if (usage) {
    // The panel's "last assistant message" breakdown; cumulative totals come
    // from `get_session_stats` and are set separately.
    state.lastUsage = usage;
  }

  const text = contentToText(message.content);
  const thinking = contentToThinking(message.content);
  if (text.length > 0 || thinking.length > 0) {
    events.push({ type: 'agent/message', at: now(), text, thinking });
  }

  if (message.stopReason === 'aborted') {
    state.streaming = false;
    events.push({ type: 'agent/run-end', at: now(), reason: 'aborted' });
  } else if (message.stopReason === 'error') {
    events.push(notice('error', 'The model request failed.', now));
  }

  return { events, state };
}

function mapToolStart(record: RpcRecord, now: () => number): MappedRecord {
  const toolCallId = stringField(record, 'toolCallId') ?? `tool-${now()}`;
  const toolName = stringField(record, 'toolName') ?? 'tool';
  const args = asRecord(record['args']);
  return {
    events: [
      {
        type: 'agent/tool-start',
        at: now(),
        toolCallId,
        name: toolName,
        title: describeToolCall(toolName, args),
        input: safeStringify(record['args']),
      },
    ],
  };
}

function mapToolUpdate(record: RpcRecord, now: () => number): MappedRecord {
  const toolCallId = stringField(record, 'toolCallId');
  if (!toolCallId) {
    return { events: [] };
  }
  return {
    events: [
      {
        type: 'agent/tool-update',
        at: now(),
        toolCallId,
        output: resultToText(record['partialResult']),
        status: 'running',
      },
    ],
  };
}

function mapToolEnd(record: RpcRecord, now: () => number): MappedRecord {
  const toolCallId = stringField(record, 'toolCallId');
  if (!toolCallId) {
    return { events: [] };
  }
  return {
    events: [
      {
        type: 'agent/tool-end',
        at: now(),
        toolCallId,
        status: record['isError'] === true ? 'error' : 'ok',
        output: resultToText(record['result']),
      },
    ],
  };
}

function mapCompactionEnd(record: RpcRecord, now: () => number): MappedRecord {
  if (record['aborted'] === true) {
    return { events: [notice('warn', 'Compaction was aborted.', now)] };
  }
  const error = stringField(record, 'errorMessage');
  if (error) {
    return { events: [notice('error', `Compaction failed: ${error}`, now)] };
  }
  // Success records the boundary as its own marker row (summary included),
  // replacing the old "Context compacted." notice: the divider now sits where
  // the fold happened, in the live transcript as well, and the summary it
  // carries is the one the agent went forward with.
  const result = asRecord(record['result']);
  return {
    events: [
      {
        type: 'agent/compaction',
        at: now(),
        summary: asString(result?.['summary']) ?? '',
        tokensBefore: asNumber(result?.['tokensBefore']),
      },
    ],
  };
}

function notice(level: NoticeLevel, text: string, now: () => number): AgentEvent {
  return { type: 'agent/notice', at: now(), level, text };
}

function stringField(record: RpcRecord, key: string): string | undefined {
  return asString(record[key]);
}

function numberField(record: RpcRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toUsage(usage: (RpcUsage & { total?: number }) | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const reasoning = usage.reasoning ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.totalTokens ?? usage.total ?? input + output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * `get_session_stats` -> the state patch the footer renders: cumulative tokens,
 * cumulative cost, and how full the context window is. Cumulative (not
 * per-message) is what pi's own footer shows, so Morse shows the same numbers.
 */
export function toSessionStats(
  stats: RpcSessionStatsData | undefined,
): Partial<AgentSessionState> {
  if (!stats) {
    return {};
  }
  const patch: Partial<AgentSessionState> = {};
  const usage = toUsage(stats.tokens);
  if (usage) {
    patch.usage = usage;
  }
  if (typeof stats.cost === 'number' && Number.isFinite(stats.cost)) {
    patch.costUsd = stats.cost;
  }
  const context = stats.contextUsage;
  if (context && typeof context.contextWindow === 'number') {
    patch.contextUsage = {
      tokens: typeof context.tokens === 'number' ? context.tokens : null,
      contextWindow: context.contextWindow,
      percent: typeof context.percent === 'number' ? context.percent : null,
    };
  }
  if (typeof stats.totalMessages === 'number') {
    patch.counts = {
      userMessages: stats.userMessages ?? 0,
      assistantMessages: stats.assistantMessages ?? 0,
      toolCalls: stats.toolCalls ?? 0,
      toolResults: stats.toolResults ?? 0,
      totalMessages: stats.totalMessages,
    };
  }
  return patch;
}

export function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  const blocks = asArray(content);
  if (!blocks) {
    return '';
  }
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record || record['type'] !== 'text') {
      continue;
    }
    parts.push(asString(record['text']) ?? '');
  }
  return parts.join('');
}

export function contentToThinking(content: unknown): string {
  const blocks = asArray(content);
  if (!blocks) {
    return '';
  }
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    const type = asString(record['type']);
    if (type !== 'thinking' && type !== 'reasoning') {
      continue;
    }
    parts.push(asString(record['thinking']) ?? asString(record['text']) ?? '');
  }
  return parts.join('');
}

/** Image content blocks (persisted attachments) of a user message. */
export function contentToImages(content: unknown): PromptImage[] {
  const blocks = asArray(content);
  if (!blocks) {
    return [];
  }
  const images: PromptImage[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record || asString(record['type']) !== 'image') {
      continue;
    }
    const data = asString(record['data']);
    if (!data) {
      continue;
    }
    images.push({ data, mimeType: asString(record['mimeType']) ?? 'image/png' });
  }
  return images;
}

const PIN_MENTION = /^@([^\s]+?)(?::(\d+)-(\d+))?$/;

/**
 * Inverse of the adapter's `appendPinMentions`: the trailing `@path[:s-e]`
 * lines a prompt was sent with come back out, so a resumed session renders the
 * pins as attachment chips and the bubble keeps the user's own words only.
 */
export function splitTrailingMentions(
  text: string,
): { text: string; pins: Array<{ path: string; startLine?: number; endLine?: number }> } {
  const lines = text.split('\n');
  let cursor = lines.length;
  const pins: Array<{ path: string; startLine?: number; endLine?: number }> = [];
  while (cursor > 0) {
    const match = PIN_MENTION.exec(lines[cursor - 1] ?? '');
    const record = match
      ? {
          path: match[1] ?? '',
          ...(match[2] !== undefined ? { startLine: Number(match[2]) } : {}),
          ...(match[3] !== undefined ? { endLine: Number(match[3]) } : {}),
        }
      : undefined;
    // A pin path is a plain file path; a prose sentence with an `@` in the
    // middle ("what about @me?") does not end with one, so prose stays intact.
    if (!record || record.path.length === 0) {
      break;
    }
    pins.unshift(record);
    cursor -= 1;
  }
  if (cursor === lines.length) {
    return { text, pins: [] };
  }
  // Drop the single blank line the adapter put between the prose and the pins.
  let prose = lines.slice(0, cursor).join('\n');
  while (prose.endsWith('\n')) {
    prose = prose.slice(0, -1);
  }
  return { text: prose, pins };
}

export function resultToText(result: unknown): string | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result === 'string') {
    return result;
  }
  const record = asRecord(result);
  if (!record) {
    return safeStringify(result);
  }
  const text = contentToText(record['content']);
  return text.length > 0 ? text : safeStringify(record);
}

export function describeToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return toolName;
  }
  const command = asString(args['command']) ?? asString(args['cmd']);
  if (toolName === 'bash' && command) {
    return `bash: ${truncate(command, 100)}`;
  }
  const path =
    asString(args['path']) ??
    asString(args['file_path']) ??
    asString(args['filePath']) ??
    asString(args['file']) ??
    asString(args['target']);
  if (path) {
    return `${toolName}: ${truncate(path, 100)}`;
  }
  const pattern = asString(args['pattern']) ?? asString(args['query']);
  if (pattern) {
    return `${toolName}: ${truncate(pattern, 100)}`;
  }
  return toolName;
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** Session entries timestamp in ISO (`2026-…`); agent messages in Unix ms. */
function entryTimestamp(value: unknown): number | undefined {
  const ms = asNumber(value);
  if (ms !== undefined) {
    return ms;
  }
  const iso = asString(value);
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
