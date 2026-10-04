import type { AgentEvent } from '@morse/core';
import type {
  AssistantTranscriptItem,
  ChatPin,
  HostToClientMessage,
  NoticeLevel,
  PromptImage,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from '@morse/protocol';

export interface TranscriptProjectorOptions {
  emit: (message: HostToClientMessage) => void;
  now?: () => number;
  idPrefix?: string;
}

/**
 * Turns the agent's transport-neutral events into the frontend's transcript.
 * One implementation shared by the VS Code host and the NestJS host, so both
 * render byte-identical conversations.
 */
export class TranscriptProjector {
  private readonly items: TranscriptItem[] = [];
  private readonly toolIndexes = new Map<string, number>();
  private assistantIndex = -1;
  private counter = 0;
  private readonly now: () => number;
  private readonly idPrefix: string;

  constructor(private readonly options: TranscriptProjectorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.idPrefix = options.idPrefix ?? 'morse';
  }

  snapshot(): TranscriptItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  reset(): void {
    this.items.length = 0;
    this.toolIndexes.clear();
    this.assistantIndex = -1;
    this.options.emit({ type: 'transcript/replace', payload: { items: [] } });
  }

  userPrompt(text: string, images?: PromptImage[], pins?: ChatPin[]): void {
    const item: UserTranscriptItem = {
      kind: 'user',
      id: this.nextId('user'),
      at: this.now(),
      text,
      ...(images && images.length > 0 ? { images } : {}),
      ...(pins && pins.length > 0 ? { pins } : {}),
    };
    this.assistantIndex = -1;
    this.appendItem(item);
  }

  /** Appends an item that already happened (a seeded history entry). */
  append(item: TranscriptItem): void {
    this.items.push(item);
    this.options.emit({ type: 'transcript/append', payload: { ...item } });
  }

  /**
   * Replaces the whole transcript in one message. Used when a fork re-parents
   * the session: the branch after the edited message no longer exists, so the
   * client must drop those rows instead of appending to them.
   */
  replace(items: TranscriptItem[]): void {
    this.items.length = 0;
    this.items.push(...items);
    this.toolIndexes.clear();
    this.assistantIndex = -1;
    this.options.emit({ type: 'transcript/replace', payload: { items: this.snapshot() } });
  }

  /**
   * Inserts an older history page in front of everything already shown. The
   * recorded indexes point into `items`, so they shift by the page size.
   */
  prepend(items: TranscriptItem[]): void {
    if (items.length === 0) {
      return;
    }
    this.items.unshift(...items);
    if (this.assistantIndex !== -1) {
      this.assistantIndex += items.length;
    }
    for (const [toolCallId, index] of this.toolIndexes) {
      this.toolIndexes.set(toolCallId, index + items.length);
    }
    this.options.emit({ type: 'transcript/prepend', payload: { items } });
  }

  notice(level: NoticeLevel, text: string): void {
    this.appendItem({ kind: 'notice', id: this.nextId('notice'), at: this.now(), level, text });
  }

  /** The live compaction boundary: a marker row for where the context reset. */
  private appendMarker(event: { at: number; summary: string; tokensBefore?: number }): void {
    const { summary, tokensBefore } = event;
    this.appendItem({
      kind: 'compaction',
      id: this.nextId('compaction'),
      at: this.now(),
      ...(summary.length > 0 ? { summary } : {}),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
    });
  }

  error(message: string, detail?: string): void {
    // A command failure with a session on screen is conversation content: the
    // red row says what failed, where it happened. It must NOT also raise the
    // wire `error` — the frontend renders that as its "Offline — the host
    // wouldn't take this frontend" banner (Reload / Retry buttons included),
    // which describes a handshake that never failed: a rejected `compact`
    // looked like a dead connection. The wire error stays reserved for a
    // refusing handshake (see the controller's `emitWireError`).
    this.appendItem({
      kind: 'notice',
      id: this.nextId('error'),
      at: this.now(),
      level: 'error',
      text: detail ? `${message}\n${detail}` : message,
    });
  }

  apply(event: AgentEvent): void {
    switch (event.type) {
      case 'agent/run-start':
        this.assistantIndex = -1;
        break;
      case 'agent/delta':
        this.applyDelta(event.channel, event.delta);
        break;
      case 'agent/message':
        this.applyMessage(event.text, event.thinking);
        break;
      case 'agent/tool-start':
        this.applyToolStart(event.toolCallId, event.name, event.title, event.input);
        break;
      case 'agent/tool-update':
        this.applyToolUpdate(event.toolCallId, event.output, event.status);
        break;
      case 'agent/tool-end':
        this.applyToolEnd(event.toolCallId, event.status, event.output, event.durationMs);
        break;
      case 'agent/run-end':
        this.finishAssistant(event.reason === 'error' ? undefined : event.reason);
        break;
      case 'agent/notice':
        this.notice(event.level, event.text);
        break;
      case 'agent/compaction':
        // Live compaction: the marker lands right here, in the middle of the
        // conversation it summarizes — the transcript row and the divider stay
        // in place for every later replay of this warm transcript.
        this.appendMarker(event);
        break;
      case 'agent/fatal':
        this.error(event.message, event.detail);
        break;
      default:
        break;
    }
  }

  private applyDelta(channel: 'text' | 'thinking', delta: string): void {
    const item = this.ensureAssistant();
    this.options.emit({
      type: 'transcript/delta',
      payload: channel === 'text' ? { id: item.id, text: delta } : { id: item.id, thinking: delta },
    });
    item[channel] += delta;
    item.streaming = true;
  }

  private applyMessage(text: string, thinking: string): void {
    const item = this.ensureAssistant();
    item.text = text;
    item.thinking = thinking;
    item.streaming = false;
    this.assistantIndex = -1;
    this.options.emit({ type: 'transcript/update', payload: { ...item } });
  }

  private finishAssistant(reason: 'settled' | 'aborted' | undefined): void {
    if (this.assistantIndex === -1) {
      return;
    }
    const item = this.items[this.assistantIndex];
    if (item && item.kind === 'assistant') {
      item.streaming = false;
      if (reason === 'aborted' && item.text.length === 0) {
        item.text = '_Run aborted._';
      }
      this.options.emit({ type: 'transcript/update', payload: { ...item } });
    }
    this.assistantIndex = -1;
  }

  private applyToolStart(
    toolCallId: string,
    name: string,
    title: string,
    input: string | undefined,
  ): void {
    const item: ToolTranscriptItem = {
      kind: 'tool',
      id: this.nextId('tool'),
      at: this.now(),
      name,
      title,
      status: 'running',
      input,
    };
    this.toolIndexes.set(toolCallId, this.items.length);
    this.appendItem(item);
  }

  private applyToolUpdate(
    toolCallId: string,
    output: string | undefined,
    status: 'running' | 'ok' | 'error' | undefined,
  ): void {
    const item = this.toolItem(toolCallId);
    if (!item) {
      return;
    }
    if (output !== undefined) {
      item.output = output;
    }
    if (status !== undefined) {
      item.status = status;
    }
    this.updateItem(item);
  }

  private applyToolEnd(
    toolCallId: string,
    status: 'ok' | 'error',
    output: string | undefined,
    durationMs: number | undefined,
  ): void {
    const item = this.toolItem(toolCallId);
    if (!item) {
      return;
    }
    item.status = status;
    if (output !== undefined) {
      item.output = output;
    }
    // pi's `tool_execution_end` carries no duration, and a finished turn can
    // only show "Worked for Ns" if one is recorded. Measure it from the start
    // we stamped ourselves; a host that does report one still wins.
    item.durationMs = durationMs ?? Math.max(0, this.now() - item.at);
    this.updateItem(item);
    this.toolIndexes.delete(toolCallId);
  }

  private ensureAssistant(): AssistantTranscriptItem {
    const existing = this.assistantIndex >= 0 ? this.items[this.assistantIndex] : undefined;
    if (existing && existing.kind === 'assistant') {
      return existing;
    }
    const item: AssistantTranscriptItem = {
      kind: 'assistant',
      id: this.nextId('assistant'),
      at: this.now(),
      text: '',
      thinking: '',
      streaming: true,
    };
    this.assistantIndex = this.items.length;
    this.appendItem(item);
    return item;
  }

  private toolItem(toolCallId: string): ToolTranscriptItem | undefined {
    const index = this.toolIndexes.get(toolCallId);
    if (index === undefined) {
      return undefined;
    }
    const item = this.items[index];
    return item && item.kind === 'tool' ? item : undefined;
  }

  private appendItem(item: TranscriptItem): void {
    this.items.push(item);
    this.options.emit({ type: 'transcript/append', payload: { ...item } });
  }

  private updateItem(item: TranscriptItem): void {
    this.options.emit({ type: 'transcript/update', payload: { ...item } });
  }

  private nextId(kind: string): string {
    this.counter += 1;
    return `${this.idPrefix}-${kind}-${this.counter}`;
  }
}
