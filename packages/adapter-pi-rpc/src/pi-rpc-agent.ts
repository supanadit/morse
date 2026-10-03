import {
  THINKING_LEVELS,
  type AgentEvent,
  type AgentEventListener,
  type AgentForkMessage,
  type AgentGateway,
  type AgentHistoryEntry,
  type AgentHistoryPage,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentSessionState,
  type AgentCommand,
  type AgentCommandSource,
  type ChatPin,
  type ModelRef,
  type MorseLogger,
  type NoticeLevel,
  type PromptDisposition,
  type PromptImage,
  type PromptMode,
  type ThinkingLevel,
  type WorkspaceRef,
} from '@morse/core';
import { mapSessionEvent, activePathEntries, toEntryHistory, toSessionStats } from './event-mapping.js';
import { PiRpcClient } from './internal/rpc-client.js';
import {
  asRecord,
  asString,
  type RpcExtensionUiRequest,
  type RpcCommandInfo,
  type RpcModel,
  type RpcRecord,
  type RpcSessionStateData,
  type RpcSessionStatsData,
} from './internal/rpc-types.js';
import type { PiSpawn } from './internal/resolve-pi.js';

export interface PiRpcAgentOptions {
  spawn: PiSpawn;
  workspace: WorkspaceRef;
  logger: MorseLogger;
  sessionPath?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  now?: () => number;
}

/**
 * Compaction summarizes the entire context in one model request — minutes on a
 * slow local model. Far above the transport's 30 s default, yet still a cap: a
 * hung pi must not wedge the composer's Working state forever.
 */
const COMPACT_REQUEST_TIMEOUT_MS = 600_000;

/**
 * `AgentGateway` implemented on top of a `pi --mode rpc` subprocess.
 * Swapping transports (SDK in-process, remote container, ...) means writing
 * another implementation of this port — nothing above it changes.
 */
export class PiRpcAgent implements AgentGateway {
  private readonly client: PiRpcClient;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly now: () => number;
  private sessionState: AgentSessionState;
  private ready = false;
  private disposed = false;
  /** Full mapped history, fetched once and paged locally (see `history`). */
  private historyCache: AgentHistoryEntry[] | undefined;

  constructor(private readonly options: PiRpcAgentOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sessionState = {
      workspace: options.workspace,
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
    };
    this.client = new PiRpcClient({
      command: options.spawn.command,
      args: options.spawn.args,
      cwd: options.workspace.cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
      onRecord: (record) => {
        this.onRecord(record);
      },
      onStderr: (text) => {
        const trimmed = text.trim();
        if (trimmed.length > 0) {
          this.options.logger.debug(`pi: ${trimmed}`);
        }
      },
      onExit: (info) => {
        this.ready = false;
        if (!this.disposed) {
          this.emit({
            type: 'agent/fatal',
            at: this.now(),
            message: `The pi agent stopped (code=${info.code === null ? 'null' : info.code}).`,
          });
        }
      },
    });
  }

  /** Spawns the subprocess and reads its initial state. Throws when pi is missing. */
  async initialize(): Promise<AgentSessionState> {
    this.client.start();
    await this.refreshState();
    return this.snapshotState();
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async state(): Promise<AgentSessionState> {
    if (!this.ready) {
      await this.refreshState();
    }
    return this.snapshotState();
  }

  /**
   * Resumed sessions keep their messages on disk; `get_messages` is how a client
   * shows what was said before this connection existed.
   *
   * pi's `get_messages` has no cursor, so the full mapping is fetched once and
   * cached; pages are then sliced locally from the end. The cache is dropped on
   * the next prompt, so a re-seed never serves stale history.
   */
  async history(options: { limit?: number; before?: string } = {}): Promise<AgentHistoryPage> {
    const entries = await this.historyEntries();
    const total = entries.length;
    const limit = options.limit !== undefined && options.limit > 0 ? options.limit : total;
    // `before` is the index of the oldest entry the caller already holds;
    // absent means "the newest page".
    const requested = options.before === undefined ? total : Number(options.before);
    const end = Number.isFinite(requested)
      ? Math.max(0, Math.min(total, Math.trunc(requested)))
      : total;
    const start = Math.max(0, end - limit);
    return {
      entries: entries.slice(start, end),
      hasOlder: start > 0,
      ...(start > 0 ? { before: String(start) } : {}),
    };
  }

  private async historyEntries(): Promise<AgentHistoryEntry[]> {
    if (this.historyCache !== undefined) {
      return this.historyCache;
    }
    // `get_entries` carries the full session history INCLUDING the entries a
    // compaction folded away (with the compaction entry marking the cut), and
    // id/parentId link the current branch: `get_messages` only mirrors what the
    // agent sees now, so a resumed session would silently shrink to everything
    // after the last compaction (with the start reading "Start of
    // conversation").
    const data = await this.client.request<{ entries?: unknown[]; leafId?: unknown }>({
      type: 'get_entries',
    });
    this.historyCache = toEntryHistory(activePathEntries(data));
    return this.historyCache;
  }

  async prompt(
    text: string,
    mode: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
  ): Promise<PromptDisposition> {
    const attachment = images && images.length > 0 ? toPiImages(images) : undefined;
    const imageArgs = attachment ? { images: attachment } : {};
    // Pins render as `@path[:start-end]` mention lines at the end of the
    // message: pi conventions, and visible in every pi frontend as exactly the
    // references they are — never prose pretending to be the user's words.
    const message = appendPinMentions(text, pins);
    // A new prompt appends to pi's history, so any cached read is now stale.
    this.historyCache = undefined;
    const command =
      mode === 'steer'
        ? ({ type: 'steer', message, ...imageArgs } as const)
        : mode === 'followUp'
          ? ({ type: 'follow_up', message, ...imageArgs } as const)
          : ({ type: 'prompt', message, ...imageArgs } as const);
    const data = await this.client.request<{ disposition?: string }>(command);
    const disposition = data?.disposition;
    if (disposition === 'queued' || disposition === 'handled') {
      return disposition;
    }
    return 'started';
  }

  async abort(): Promise<void> {
    await this.client.request({ type: 'abort' });
  }

  /** Past user messages pi can fork from (its `get_fork_messages`). */
  async forkMessages(): Promise<AgentForkMessage[]> {
    const data = await this.client.request<{ messages?: unknown[] }>({
      type: 'get_fork_messages',
    });
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const result: AgentForkMessage[] = [];
    for (const raw of messages) {
      const record = asRecord(raw);
      const entryId = record ? asString(record['entryId']) : undefined;
      if (!record || !entryId) {
        continue;
      }
      result.push({ entryId, text: asString(record['text']) ?? '' });
    }
    return result;
  }

  /**
   * Forks the conversation before a user entry. pi writes a new session file and
   * rebinds in place, so the process stays alive but `sessionFile` changes —
   * the cached state is refreshed before returning.
   */
  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const data = await this.client.request<{ text?: string; cancelled?: boolean }>({
      type: 'fork',
      entryId,
    });
    // The conversation was re-parented: any cached history read is now stale.
    this.historyCache = undefined;
    if (data?.cancelled === true) {
      return { text: data.text ?? '', cancelled: true };
    }
    await this.refreshState();
    return { text: data?.text ?? '', cancelled: false };
  }

  async setModel(model: ModelRef): Promise<void> {
    const data = await this.client.request<RpcModel>({
      type: 'set_model',
      provider: model.provider,
      modelId: model.id,
    });
    this.patchState({ model: data ? toModelRef(data) : model });
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.client.request({ type: 'set_thinking_level', level });
    this.patchState({ thinkingLevel: level });
  }

  async compact(customInstructions?: string): Promise<void> {
    // Compaction summarizes the whole context in one model request, so the
    // transport's 30 s default (sized for state/model calls) is far too short:
    // a slow local model takes minutes, and timing out here showed "pi did not
    // answer 'compact' within 30000 ms" while the agent was still working.
    await this.client.request(
      customInstructions === undefined
        ? { type: 'compact' }
        : { type: 'compact', customInstructions },
      COMPACT_REQUEST_TIMEOUT_MS,
    );
    await this.refreshStats();
  }

  respondToInteraction(response: AgentInteractionResponse): Promise<void> {
    this.client.respond({
      type: 'extension_ui_response',
      id: response.requestId,
      value: response.value,
      confirmed: response.confirmed,
      cancelled: response.cancelled,
    });
    return Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    await this.client.dispose();
  }

  private async refreshState(): Promise<void> {
    const state = await this.client.request<RpcSessionStateData>({ type: 'get_state' });
    const models = await this.client
      .request<{ models?: RpcModel[] }>({ type: 'get_available_models' })
      .catch(() => undefined);
    const levels = await this.client
      .request<{ levels?: string[] }>({ type: 'get_available_thinking_levels' })
      .catch(() => undefined);
    const commands = await this.client
      .request<{ commands?: RpcCommandInfo[] }>({ type: 'get_commands' })
      .catch(() => undefined);

    const availableModels = (models?.models ?? []).map(toModelRef);
    const availableThinkingLevels = dedupeThinkingLevels(
      (levels?.levels ?? []).map(toThinkingLevel).filter(isDefined),
    );
    const thinkingLevel = toThinkingLevel(state.thinkingLevel);

    this.sessionState = {
      ...this.sessionState,
      sessionId: state.sessionFile ?? state.sessionId,
      sessionTitle: state.sessionName,
      model: state.model ? toModelRef(state.model) : this.sessionState.model,
      thinkingLevel: thinkingLevel ?? this.sessionState.thinkingLevel,
      availableModels,
      availableThinkingLevels:
        availableThinkingLevels.length > 0 ? availableThinkingLevels : [...THINKING_LEVELS],
      availableCommands: toCommands(commands?.commands),
      streaming: state.isStreaming === true,
    };
    this.ready = true;
    await this.refreshStats();
    this.emit({ type: 'agent/ready', at: this.now(), state: this.snapshotState() });
  }

  /**
   * Pulls the cumulative token/cost/context totals pi keeps for the session, so
   * the footer can show the same numbers the TUI does. Best-effort: an older pi
   * without `get_session_stats` simply leaves the previous values in place.
   */
  private async refreshStats(): Promise<void> {
    const stats = await this.client
      .request<RpcSessionStatsData>({ type: 'get_session_stats' })
      .catch(() => undefined);
    const patch = toSessionStats(stats);
    if (Object.keys(patch).length === 0) {
      return;
    }
    this.sessionState = { ...this.sessionState, ...patch };
    this.emit({ type: 'agent/state', at: this.now(), state: this.snapshotState() });
  }

  private onRecord(record: RpcRecord): void {
    if (record['type'] === 'extension_ui_request') {
      this.onUiRequest(record as unknown as RpcExtensionUiRequest);
      return;
    }

    switch (record['type']) {
      case 'agent_settled':
        this.patchState({ streaming: false });
        this.emit({ type: 'agent/run-end', at: this.now(), reason: 'settled' });
        // A settled run is the moment cumulative tokens/cost/context are final.
        void this.refreshStats();
        return;
      case 'thinking_level_changed': {
        const level = toThinkingLevel(asString(record['level']));
        if (level) {
          this.patchState({ thinkingLevel: level });
        }
        return;
      }
      case 'session_info_changed':
        this.patchState({ sessionTitle: asString(record['name']) });
        return;
      case 'queue_update':
        return;
      default:
        break;
    }

    const mapped = mapSessionEvent(record, this.now);
    if (mapped.state) {
      this.patchState(mapped.state);
    }
    for (const event of mapped.events) {
      this.emit(event);
    }
    // Compaction rewrites the context, so the footer's percentage must follow.
    if (record['type'] === 'compaction_end') {
      void this.refreshStats();
    }
  }

  private onUiRequest(request: RpcExtensionUiRequest): void {
    const method = request.method;
    if (method === 'notify') {
      this.emit({
        type: 'agent/notice',
        at: this.now(),
        level: toNoticeLevel(request.notifyType),
        text: request.message ?? '',
      });
      return;
    }
    if (
      method !== 'select' &&
      method !== 'confirm' &&
      method !== 'input' &&
      method !== 'editor'
    ) {
      // Fire-and-forget terminal concerns (setTitle/setStatus/setWidget/...):
      // nothing to answer, and Morse has no terminal chrome to update.
      this.options.logger.debug(`pi requested unsupported UI method "${method}"; ignoring.`);
      return;
    }
    this.emit({
      type: 'agent/interaction',
      at: this.now(),
      request: toInteractionRequest(method, request),
    });
  }

  private patchState(patch: Partial<AgentSessionState>): void {
    this.sessionState = { ...this.sessionState, ...patch };
    this.emit({ type: 'agent/state', at: this.now(), state: this.snapshotState() });
  }

  private snapshotState(): AgentSessionState {
    return {
      ...this.sessionState,
      workspace: { ...this.sessionState.workspace },
      availableModels: [...this.sessionState.availableModels],
      availableThinkingLevels: [...this.sessionState.availableThinkingLevels],
      availableCommands: [...this.sessionState.availableCommands],
    };
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.options.logger.error('Agent event listener failed', error);
      }
    }
  }
}

function toInteractionRequest(
  kind: 'select' | 'confirm' | 'input' | 'editor',
  request: RpcExtensionUiRequest,
): AgentInteractionRequest {  const title = request.title ?? kind;
  switch (kind) {
    case 'select':
      return {
        requestId: request.id,
        kind: 'select',
        title,
        options: (request.options ?? []).map((value) => ({ value, label: value })),
      };
    case 'confirm':
      return { requestId: request.id, kind: 'confirm', title, message: request.message ?? '' };
    case 'input':
      return {
        requestId: request.id,
        kind: 'input',
        title,
        placeholder: request.placeholder,
      };
    case 'editor':
      return { requestId: request.id, kind: 'editor', title, value: request.prefill };
  }
}

function toModelRef(model: RpcModel): ModelRef {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function toThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) {
    return undefined;
  }
  return THINKING_LEVELS.find((level) => level === value);
}

function dedupeThinkingLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
  return [...new Set(levels)];
}

/**
 * pi reports command sources as `extension`, `prompt` or `skill`. Anything else
 * (a future source) is treated as an extension command so it still runs.
 */
function toCommandSource(value: string | undefined): AgentCommandSource {
  return value === 'prompt' || value === 'skill' ? value : 'extension';
}

function toCommands(items: RpcCommandInfo[] | undefined): AgentCommand[] {
  return (items ?? [])
    .filter((item): item is RpcCommandInfo & { name: string } => {
      return typeof item.name === 'string' && item.name.trim().length > 0;
    })
    .map((item) => ({
      name: item.name,
      description: item.description,
      source: toCommandSource(item.source),
    }));
}

function toNoticeLevel(value: string | undefined): NoticeLevel {
  if (value === 'error') {
    return 'error';
  }
  if (value === 'warning' || value === 'warn') {
    return 'warn';
  }
  return 'info';
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** pi's prompt command takes images as content blocks. */
function toPiImages(images: PromptImage[]): Array<{ type: 'image'; data: string; mimeType: string }> {
  return images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
}

/**
 * Apples the pin mentions after the user's words: `@path` for a whole file,
 * `@path:start-end` for an editor selection. When the message is pins only (an
 * image with no caption, say), the message is the mentions.
 */
export function appendPinMentions(text: string, pins: ChatPin[] | undefined): string {
  if (!pins || pins.length === 0) {
    return text;
  }
  const mentions = pins
    .map((pin) => {
      if (pin.startLine === undefined) {
        return `@${pin.path}`;
      }
      const end = pin.endLine ?? pin.startLine;
      return `@${pin.path}:${pin.startLine}-${end}`;
    })
    .join('\n');
  const prose = text.trim();
  return prose.length > 0 ? `${prose}\n\n${mentions}` : mentions;
}
