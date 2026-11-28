import { join, resolve } from 'node:path';
import {
  THINKING_LEVELS,
  type AgentHistoryEntry,
  type AgentHistoryPage,
  type AgentInteractionResponse,
  type AgentSessionState,
  type AgentUserMessage,
  type ChatPin,
  type ModelRef,
  type PromptDisposition,
  type PromptImage,
  type PromptMode,
  type ThinkingLevel,
  type WorkspaceRef,
  Session,
} from '@morse/agent';
import { appendPinMentions, type MorseLogger } from '@morse/system';
import {
  mapSessionEvent,
  activePathEntries,
  toEntryHistory,
  toSessionStats,
  userMessagesOf,
} from './event-mapping.js';
import {
  buildCommandList,
  dedupeThinkingLevels,
  toInteractionRequest,
  toModelRef,
  toNoticeLevel,
  toPiImages,
  toThinkingLevel,
  upsertStatus,
  upsertWidget,
  type CommandContext,
} from './pi-rpc-helpers.js';
import { isDefined } from './internal/rpc/helpers.js';
import {
  emptySpeed,
  loadSpeed,
  recordSpeed,
  saveSpeed,
  snapshotSpeed,
  type StoredSessionSpeed,
} from './session-speed.js';
import { stripAnsi } from './internal/ansi-text.js';
import { PromptWatcher } from './internal/prompt-watch.js';
import { resolveAgentDir } from './internal/project-trust.js';
import { PiRpcClient } from './internal/rpc-client.js';
import {
  asNumber,
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
  /**
   * Where per-session derived stats (speed) are persisted, one file per
   * session. Absent keeps them in memory only — they do not survive the host.
   */
  dataDir?: string;
}

/**
 * Compaction summarizes the entire context in one model request — minutes on a
 * slow local model. Far above the transport's 30 s default, yet still a cap: a
 * hung pi must not wedge the composer's Working state forever.
 */
const COMPACT_REQUEST_TIMEOUT_MS = 600_000;

/**
 * `Session` implemented on top of a `pi --mode rpc` subprocess.
 * Swapping harnesses (OpenCode, an in-process SDK, a remote container, ...) means
 * writing another subclass — nothing above `Session` changes.
 */
export class PiRpcAgent extends Session {
  readonly kind = 'pi';
  private readonly client: PiRpcClient;
  private readonly now: () => number;
  private ready = false;
  private disposed = false;
  /** A failed message ended the run already; pi's later settled is not a second finish. */
  private suppressNextSettled = false;
  /**
   * Watches this session's prompt directories so a template written outside
   * Morse (the editor, `vim`, `nano`) reaches the palette without a reload.
   */
  private readonly promptWatcher: PromptWatcher;
  /** Full mapped history, fetched once and paged locally (see `history`). */
  private historyCache: AgentHistoryEntry[] | undefined;
  /**
   * When the assistant message now streaming began (`message_start`); its span
   * at `message_end` is the only clock pi does not keep for us.
   */
  private assistantStartedAt: number | undefined;
  /** The persisted speed accumulator for the attached session, when there is one. */
  private speedStored: StoredSessionSpeed | undefined;

  constructor(private readonly options: PiRpcAgentOptions) {
    super(options.logger, {
      workspace: options.workspace,
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
    });
    this.now = options.now ?? (() => Date.now());
    this.client = new PiRpcClient({
      command: options.spawn.command,
      args: options.spawn.args,
      cwd: options.workspace.cwd,
      shell: options.spawn.shell,
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
        // A dead process cannot end its run: clear Working, or Stop keeps
        // pointing at a child that no longer exists.
        this.patch({ streaming: false }, this.now());
        if (!this.disposed) {
          // pi writes its uncaught-exception trace to stderr, which the JSONL
          // stream never carries. Passing the tail along as `detail` is what
          // turns "exited (code=1)" into an error the reader can act on (the
          // `agent/fatal` row shows it under the message; see the transcript).
          this.emit({
            type: 'agent/fatal',
            at: this.now(),
            message: `The pi agent stopped (code=${info.code === null ? 'null' : info.code}).`,
            ...(info.stderr !== undefined && info.stderr.length > 0 ? { detail: info.stderr } : {}),
          });
        }
      },
    });
    this.promptWatcher = new PromptWatcher(
      () => [
        join(resolveAgentDir(options.env), 'prompts'),
        resolve(options.workspace.cwd, '.pi', 'prompts'),
      ],
      () => void this.refreshCommands(),
    );
    this.promptWatcher.start();
  }

  /** Spawns the subprocess and reads its initial state. Throws when pi is missing. */
  async initialize(): Promise<AgentSessionState> {
    this.client.start();
    await this.refreshState();
    return this.state();
  }

  override async state(): Promise<AgentSessionState> {
    // pi keeps the truth: a session resumed after the host restarted has no
    // state until `get_state` answers, so the base class's snapshot is not enough.
    if (!this.ready) {
      await this.refreshState();
    }
    return super.state();
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
    // A new run must not inherit the previous run's swallowed settle.
    this.suppressNextSettled = false;
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
    // Nothing to stop when the child is already gone; the host still needs the
    // stop to land so its queue stays paused.
    if (!this.client.running) {
      return;
    }
    await this.client.request({ type: 'abort' });
  }

  /**
   * The cached first read is exactly what a refresh must not serve: a watched
   * subagent is written by another process, so the next `history()` has to go
   * back to pi for what landed since this gateway attached.
   */
  async refreshHistory(): Promise<void> {
    this.historyCache = undefined;
  }

  /**
   * Every user message on the branch in view, oldest first.
   *
   * Read from `get_entries`'s active path rather than `get_fork_messages`: a
   * session forked before inside pi holds several branches in one file, and only
   * one of them is the conversation on screen. pi's own picker also drops a
   * message with no text, which would shift every entry after it.
   */
  async userMessages(): Promise<AgentUserMessage[]> {
    const data = await this.client.request<{ entries?: unknown[]; leafId?: unknown }>({
      type: 'get_entries',
    });
    return userMessagesOf(activePathEntries(data));
  }

  /** pi has no edit primitive: an edit is a fork, and the port says so. */
  async rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return this.fork(entryId);
  }

  /**
   * Branches at the tip. pi writes a new session file and rebinds in place, so
   * the process stays alive but the session identity changes — the cached
   * history is dropped and the state re-read before returning.
   */
  async clone(): Promise<{ cancelled: boolean }> {
    const data = await this.client.request<{ cancelled?: boolean }>({ type: 'clone' });
    this.historyCache = undefined;
    await this.refreshState();
    return { cancelled: data?.cancelled === true };
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
    // Read the levels **before** emitting: a model and its thinking levels are one
    // state to the UI. Emitting the new model first showed the picker the previous
    // model's levels for a beat — and pi scopes the levels to the current model,
    // so switching models can change which ones exist (or drop reasoning entirely).
    const thinking = await this.readThinkingLevels();
    this.patch({ model: data ? toModelRef(data) : model, ...thinking }, this.now());
  }

  /**
   * The levels the current model supports, and the level pi settled on (a model
   * without reasoning resets it to `off`). Returns a patch with nothing to say
   * when pi did not answer, so the caller keeps the last known levels instead of
   * inventing the full list — a failed refresh must not make the picker wrong.
   */
  private async readThinkingLevels(): Promise<
    Pick<Partial<AgentSessionState>, 'availableThinkingLevels' | 'thinkingLevel'>
  > {
    const [levels, state] = await Promise.all([
      this.client
        .request<{ levels?: string[] }>({ type: 'get_available_thinking_levels' })
        .catch(() => undefined),
      this.client.request<RpcSessionStateData>({ type: 'get_state' }).catch(() => undefined),
    ]);
    const available = dedupeThinkingLevels(
      (levels?.levels ?? []).map(toThinkingLevel).filter(isDefined),
    );
    const thinkingLevel = state ? toThinkingLevel(state.thinkingLevel) : undefined;
    return {
      ...(available.length > 0 ? { availableThinkingLevels: available } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    };
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.client.request({ type: 'set_thinking_level', level });
    this.patch({ thinkingLevel: level }, this.now());
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
    this.promptWatcher.stop();
    this.clearListeners();
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
    const built = await buildCommandList(commands?.commands, this.commandContext());

    // The session identity doubles as the key its speed file is stored under;
    // a fork rebinds it, so the accumulator follows the file pi now writes.
    const sessionKey = state.sessionFile ?? state.sessionId;
    this.speedStored =
      this.options.dataDir !== undefined && sessionKey !== undefined
        ? await loadSpeed(this.options.dataDir, sessionKey)
        : undefined;

    this.setState({
      ...this.box,
      sessionId: sessionKey,
      // pi's own id — the UUID in the session file's name — kept apart from the
      // file-path identity above, so a reader can line the session up with what
      // pi's own CLI lists. Explicitly (re)set: a fork must not keep the parent's.
      engineSessionId: state.sessionId,
      sessionTitle: state.sessionName,
      model: state.model ? toModelRef(state.model) : this.box.model,
      thinkingLevel: thinkingLevel ?? this.box.thinkingLevel,
      availableModels,
      availableThinkingLevels:
        availableThinkingLevels.length > 0 ? availableThinkingLevels : [...THINKING_LEVELS],
      availableCommands: built.commands,
      diagnostics: built.diagnostics,
      streaming: state.isStreaming === true,
      // Explicitly (re)set: attaching to another session must not keep the
      // previous one's speed while the new file loads.
      speed: snapshotSpeed(this.speedStored),
    });
    this.ready = true;
    await this.refreshStats();
    this.emitReady(this.now());
  }

  /**
   * Re-reads the resources behind `get_commands` and reports the result the same
   * way a fresh spawn would. The palette calls it the moment it opens, so a new
   * or edited template is there by the time the reader finishes typing.
   */
  async refreshCommands(): Promise<void> {
    if (this.disposed || !this.ready) {
      return;
    }
    const commands = await this.client
      .request<{ commands?: RpcCommandInfo[] }>({ type: 'get_commands' })
      .catch(() => undefined);
    const built = await buildCommandList(commands?.commands, this.commandContext());
    this.setState({
      ...this.box,
      availableCommands: built.commands,
      diagnostics: built.diagnostics,
    });
    this.emitState(this.now());
  }

  /** Where a command list is rebuilt from: the session's workspace and env. */
  private commandContext(): CommandContext {
    return { cwd: this.options.workspace.cwd, env: this.options.env, spawn: this.options.spawn };
  }

  /**
   * Re-reads `get_available_models` and reports it the same way a fresh spawn
   * would. The model picker calls it the moment it opens, so a model added to
   * `models.json` while this session is warm is there without reopening the
   * session or restarting the host.
   */
  async refreshModels(): Promise<void> {
    if (this.disposed || !this.ready) {
      return;
    }
    const models = await this.client
      .request<{ models?: RpcModel[] }>({ type: 'get_available_models' })
      .catch(() => undefined);
    if (models === undefined) {
      return;
    }
    this.patch({ availableModels: (models.models ?? []).map(toModelRef) }, this.now());
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
    this.patch(patch, this.now());
  }

  private onRecord(record: RpcRecord): void {
    if (record['type'] === 'extension_ui_request') {
      // SAFETY: pi only sends this shape under the `extension_ui_request` type,
      // and the handler reads each field defensively; the cast just picks the
      // narrower interface for a record the wire cannot type for us.
      this.onUiRequest(record as unknown as RpcExtensionUiRequest);
      return;
    }

    switch (record['type']) {
      case 'agent_settled':
        this.patch({ streaming: false }, this.now());
        // A provider error already ended this run as `error`; pi still sends
        // `agent_settled`, and treating that as a green finish would drain the
        // composer queue past a red failure.
        if (this.suppressNextSettled) {
          this.suppressNextSettled = false;
        } else {
          this.emit({ type: 'agent/run-end', at: this.now(), reason: 'settled' });
        }
        // A settled run is the moment cumulative tokens/cost/context are final.
        void this.refreshStats();
        return;
      case 'thinking_level_changed': {
        const level = toThinkingLevel(asString(record['level']));
        if (level) {
          this.patch({ thinkingLevel: level }, this.now());
        }
        return;
      }
      case 'session_info_changed':
        this.patch({ sessionTitle: asString(record['name']) }, this.now());
        return;
      case 'queue_update':
        return;
      case 'message_start': {
        // Remember when this message began generating: `message_end` turns the
        // span into the session's speed sample (pi reports no timing itself).
        const message = asRecord(record['message']);
        if (message?.['role'] === 'assistant') {
          this.assistantStartedAt = this.now();
        }
        return;
      }
      default:
        break;
    }

    const mapped = mapSessionEvent(record, this.now, this.box);
    if (mapped.state) {
      this.patch(mapped.state, this.now());
    }
    for (const event of mapped.events) {
      this.emit(event);
    }
    if (
      mapped.events.some((event) => event.type === 'agent/run-end' && event.reason === 'error')
    ) {
      this.suppressNextSettled = true;
    }
    // Compaction rewrites the context, so the footer's percentage must follow.
    if (record['type'] === 'compaction_end') {
      void this.refreshStats();
    }
    // A message entering the session moves the totals, counts and context the
    // usage panel shows. pi exposes those only over `get_session_stats`, so
    // waiting for `agent_settled` left the panel frozen for the whole run;
    // re-pulling as each message lands is what keeps it moving mid-run.
    if (record['type'] === 'message_end') {
      // Its span over the wire is also the session's only speed sample.
      this.trackSpeed(record);
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
        // Same boundary as the widget/status chrome: a notice is shown as DOM,
        // so any theme coloring pi forwarded is stripped here too.
        text: stripAnsi(request.message ?? ''),
      });
      return;
    }
    // The TUI chrome an extension can set over RPC: a text widget and a footer
    // status line. Both are fire-and-forget and per session, so they ride on the
    // session state and reach every frontend that renders it (the browser panel
    // and the VS Code webview alike).
    if (method === 'setWidget') {
      this.patch({ widgets: upsertWidget(this.box.widgets ?? [], request) }, this.now());
      return;
    }
    if (method === 'setStatus') {
      this.patch({ statuses: upsertStatus(this.box.statuses ?? [], request) }, this.now());
      return;
    }
    if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') {
      // Other fire-and-forget terminal concerns (setTitle/set_editor_text/...):
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

  /**
   * Folds one assistant message's span (`message_start` → `message_end`) into
   * the session's speed accumulator and persists it. Best-effort: a message
   * this host never saw start (it attached mid-stream), a session with no file
   * to key on, or a message too short to separate speed from latency is simply
   * not counted.
   */
  private trackSpeed(record: RpcRecord): void {
    const message = asRecord(record['message']);
    if (!message || message['role'] !== 'assistant') {
      return;
    }
    const startedAt = this.assistantStartedAt;
    this.assistantStartedAt = undefined;
    const dataDir = this.options.dataDir;
    const session = this.box.sessionId;
    if (startedAt === undefined || dataDir === undefined || session === undefined) {
      return;
    }
    const output = asNumber(asRecord(message['usage'])?.['output']);
    const updated = recordSpeed(
      this.speedStored ?? emptySpeed(session),
      output ?? 0,
      this.now() - startedAt,
    );
    if (updated === undefined) {
      return;
    }
    this.speedStored = updated;
    const speed = snapshotSpeed(updated);
    if (speed !== undefined) {
      this.patch({ speed }, this.now());
    }
    void saveSpeed(dataDir, updated);
  }
}
