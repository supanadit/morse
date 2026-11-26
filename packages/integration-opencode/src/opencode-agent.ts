import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  Session,
  type AgentChildSessionRef,
  type AgentFormRequest,
  type AgentHistoryPage,
  type AgentSelectRequest,
  type AgentInteractionResponse,
  type AgentSessionState,
  type AgentUserMessage,
  type ChatPin,
  type ModelRef,
  type PromptDisposition,
  type PromptImage,
  type PromptMode,
  type SessionCounts,
  type SessionSpeed,
  type ThinkingLevel,
  type TokenUsage,
  type WorkspaceRef,
} from '@morse/agent';
import {
  AgentUnavailableError,
  UnsupportedByHostError,
  appendPinMentions,
  type MorseLogger,
} from '@morse/system';
import type { OpenCodeApi } from './internal/client.js';
import {
  defaultModeId,
  readAgentCatalog,
  readDefaultModel,
  type AgentCatalog,
  type ApiAgentModel,
} from './internal/catalog.js';
import type { OpenCodeConfigGuard } from './internal/config-guard.js';
import {
  OpenCodeEventMapper,
  childRunningOf,
  toTokenUsage,
} from './internal/event-mapping.js';
import type { OpenCodeEvent, OpenCodeEventStream } from './internal/event-stream.js';
import {
  asRecord,
  asString,
  extensionOf,
  initialStateOf,
  readAvailableCommands,
  readCommandCatalog,
  resolveFallbackModel,
  sessionBusy,
  type ApiSessionInfo,
} from './opencode-helpers.js';

export type { ApiSessionInfo };
import {
  modelKey,
  thinkingLevelOf,
  thinkingLevelsOf,
  toModelRef,
  toModelRefs,
  variantForLevel,
  type ApiModel,
} from './internal/model-mapping.js';
import {
  toUserMessages,
  toHistoryEntries,
  sessionCountsOf,
  sessionSpeedOf,
  type ApiMessage,
} from './internal/message-mapping.js';
import {
  toFormRequest,
  toPermissionRequest,
  type ApiForm,
  type ApiPermissionRequest,
} from './internal/form-mapping.js';

const CHILD_RECONCILE_MS = 5_000;
/** A connection with no frame — not even a heartbeat — for this long is stalled. */
const STREAM_STALE_MS = 20_000;

/**
 * One OpenCode conversation, as a harness session.
 *
 * OpenCode's sessions live in its server, not in a process Morse owns, so this
 * class is a *view*: it creates (or attaches to) the engine session eagerly,
 * subscribes to the engine-wide event stream for that session's id, and keeps its
 * state from the events and the server's own session record. Nothing here speaks
 * for another session, and `dispose` only detaches — the conversation stays on the
 * server for a later resume.
 *
 * Engine gaps are reported, not simulated: custom compaction instructions are
 * warned about and dropped, an image that cannot be materialized is warned about
 * and omitted, and a thinking level the selected model does not declare is
 * refused. Form and permission interactions arrive in `6.4`.
 */

/** How many message pages `history`/`userMessages` will read before giving up. */
const MAX_HISTORY_PAGES = 20;
/** `history`'s page size in messages when the caller does not name one. */
const DEFAULT_HISTORY_LIMIT = 40;
/**
 * How far back a state refresh walks the stored message list. One walk feeds
 * the whole usage panel: the newest answer (the context ring), the message and
 * tool-call counts, and the speed totals the engine's own message clock gives
 * for free.
 *
 * `shortcut:` a session older than this walk undercounts its totals; upgrade
 * to a deeper walk (or a server-side aggregation) if long sessions ever show
 * numbers that stop growing.
 */
const USAGE_WALK_PAGES = 20;
/** Page size of the usage walk, in messages. */
const USAGE_PAGE_LIMIT = 100;

/**
 * How often, and for how long, the command catalog is re-read after a session
 * opens. OpenCode fills it asynchronously behind the project instance it lazily
 * creates, so a fresh server answers with nothing at first and only has the
 * project's own commands after ~2s. Four reads spread over ~3s cover that; the
 * poll stops early once the list stops growing.
 */
const COMMAND_SETTLE_ROUNDS = 4;
const COMMAND_SETTLE_MS = 800;

export interface OpenCodeAgentOptions {
  api: OpenCodeApi;
  stream: OpenCodeEventStream;
  workspace: WorkspaceRef;
  logger: MorseLogger;
  /** Attach to a persisted engine session instead of creating one. */
  sessionId?: string;
  /** The mode a newly created session should start in. Ignored when attaching. */
  mode?: string;
  /**
   * The OpenCode config dir this agent's command templates resolve from,
   * defaulting to the host's XDG one. A bot passes its own, so `localTemplates`
   * never reads the user's global commands.
   */
  configDir?: string;
  /**
   * The engine's shared config guard. The agent reports its streaming state to
   * it and releases its id on dispose, so a reload can tell whether a turn is in
   * progress.
   */
  guard?: OpenCodeConfigGuard;
}

export class OpenCodeAgent extends Session {
  readonly kind = 'opencode';

  private readonly api: OpenCodeApi;
  private readonly stream: OpenCodeEventStream;
  private readonly log: MorseLogger;
  private readonly configDir: string | undefined;
  private readonly guard: OpenCodeConfigGuard | undefined;
  private readonly mapper = new OpenCodeEventMapper();
  private readonly models = new Map<string, ApiModel>();
  /** The model each primary agent is configured to run, by mode id. */
  private readonly agentModels = new Map<string, ApiAgentModel>();
  /** The agent OpenCode resolves for a session that has not named one. */
  private defaultMode: string | undefined;
  private readonly imageFiles: string[] = [];
  private engineId: string;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  /** A refresh in flight; another request for one is folded into it. */
  private refreshing: Promise<void> | undefined;
  /** Spawned children this session listens to, by engine id (see `watchChild`). */
  private readonly childWatches = new Map<string, () => void>();
  /** The child refs behind the watches, for reports the engine does not name again. */
  private readonly childRefs = new Map<string, AgentChildSessionRef>();
  /** Last liveness each child was reported with, so repeats stay quiet. */
  private readonly childRunning = new Map<string, boolean>();
  /** A status reconcile in flight; ticks and reconnects fold into it. */
  private reconcilingChildren: Promise<void> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  /** Interaction requests already shown to the reader, by request id. */
  private readonly announced = new Set<string>();
  /** What kind of thing each pending request is, so a reply goes to its endpoint. */
  private readonly pending = new Map<string, 'form' | 'permission'>();
  /** A pending-interaction poll in flight. */
  private syncing: Promise<void> | undefined;

  private constructor(
    options: OpenCodeAgentOptions,
    session: ApiSessionInfo,
    initialState: AgentSessionState,
  ) {
    super(options.logger, initialState);
    this.api = options.api;
    this.stream = options.stream;
    this.log = options.logger;
    this.configDir = options.configDir;
    this.guard = options.guard;
    this.engineId = session.id;
    // Opened while the engine was still running it (a background subagent the
    // reader clicked into): the start event is gone, so the run is taken as in
    // flight until its end arrives — and the guard must know a turn is live.
    if (sessionBusy(session) === true) {
      this.mapper.resume();
      this.guard?.setStreaming(this.engineId, true);
      this.watchdog ??= setInterval(() => this.tickWatchdog(), CHILD_RECONCILE_MS);
    }
  }

  /**
   * Every state change goes through here, because the context window is derived
   * rather than reported: OpenCode keeps cumulative totals on the session record
   * (and in `session.usage.updated`), not how full the window is. Its own sidebar
   * counts the latest answer's tokens — prompt, output, reasoning and the cache
   * it read and wrote — against the model's window, which is what the ring in the
   * composer should show.
   */
  protected override mergeState(patch: Partial<AgentSessionState>): void {
    super.mergeState(patch);
    if (patch.streaming !== undefined) {
      // A config reload must never fire under a running turn; the guard is what
      // knows which sessions are mid-step.
      this.guard?.setStreaming(this.engineId, patch.streaming);
      if (patch.streaming) {
        this.watchdog ??= setInterval(() => this.tickWatchdog(), CHILD_RECONCILE_MS);
      }
    }
    const last = this.box.lastUsage;
    const contextWindow = this.box.model?.contextWindow;
    if (last === undefined || contextWindow === undefined || contextWindow <= 0) {
      return;
    }
    const tokens =
      last.inputTokens +
      last.outputTokens +
      (last.reasoningTokens ?? 0) +
      (last.cacheReadTokens ?? 0) +
      (last.cacheWriteTokens ?? 0);
    super.mergeState({
      contextUsage: {
        tokens,
        contextWindow,
        percent: Math.round((tokens / contextWindow) * 1000) / 10,
      },
    });
  }

  /**
   * Creates (or attaches to) the engine session before the first prompt, so the
   * session has a stable id and the caller can subscribe to it immediately.
   */
  static async open(options: OpenCodeAgentOptions): Promise<OpenCodeAgent> {
    const session =
      options.sessionId === undefined
        ? await options.api.post<ApiSessionInfo>('/session', {
            location: { directory: options.workspace.cwd },
            // An explicit choice; omitted means OpenCode applies its own
            // configuration's default agent.
            ...(options.mode === undefined ? {} : { agent: options.mode }),
          })
        : await options.api.get<ApiSessionInfo>(
            `/session/${encodeURIComponent(options.sessionId)}`,
          );
    if (session === undefined || typeof session.id !== 'string' || session.id.length === 0) {
      throw new AgentUnavailableError('OpenCode did not return a session id.');
    }

    // The catalog is a nicety: a server that cannot answer it still serves the
    // conversation, so a failure degrades the pickers instead of the session.
    const directory = session.location?.directory ?? options.workspace.cwd;
    const [models, commands, catalog] = await Promise.all([
      options.api
        .get<ApiModel[]>('/model', { 'location[directory]': directory })
        .catch((error: unknown): ApiModel[] => {
          options.logger.warn('Could not read the OpenCode model catalog', error);
          return [];
        }),
      readAvailableCommands(options.api, directory, options.logger, options.configDir),
      readAgentCatalog(options.api, directory, options.logger),
    ]);
    // A fresh session names no model until its first prompt. The model it will
    // use is the one its agent is configured to run; `/model/default` is only
    // the server's own fallback when that agent's model is not in the catalog.
    // Both are read only for a session that has no model yet — a resumed one
    // keeps the model the server recorded.
    const fallbackModel =
      session.model === undefined
        ? await resolveFallbackModel(
            options.api,
            directory,
            options.logger,
            models,
            catalog,
            session.agent ?? catalog.defaultMode,
          )
        : undefined;
    // A default the catalog a stale server returned does not list is appended so
    // the picker can name it.
    const catalogModels =
      fallbackModel === undefined ||
      models.some(
        (model) => model.providerID === fallbackModel.providerID && model.id === fallbackModel.id,
      )
        ? models
        : [...models, fallbackModel];

    const agent = new OpenCodeAgent(
      options,
      session,
      initialStateOf(
        session,
        options.workspace,
        catalogModels,
        commands,
        catalog.modes,
        fallbackModel,
      ),
    );
    agent.adoptCatalog(catalog);
    for (const model of catalogModels) {
      agent.models.set(modelKey(model), model);
    }
    agent.attach();
    agent.settleCommands(directory);
    return agent;
  }

  /** The engine's own session id, which the router derives Morse's id from. */
  get engineSessionId(): string {
    return this.engineId;
  }

  // ---------------------------------------------------------------- history

  /**
   * A page of past exchanges, newest first on the first call, oldest-first
   * *within* the page (the shape `SessionRegistry` prepends).
   *
   * Bookkeeping rows are skipped, and paging continues past a page made only of
   * them, so a resumed conversation never opens on an empty page because the
   * newest rows were `idle` markers.
   */
  async history(options: { limit?: number; before?: string } = {}): Promise<AgentHistoryPage> {
    const limit =
      options.limit !== undefined && options.limit > 0 ? options.limit : DEFAULT_HISTORY_LIMIT;
    const messages: ApiMessage[] = [];
    let cursor = options.before;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const result = await this.api.page<ApiMessage>(
        `/session/${encodeURIComponent(this.engineId)}/message`,
        {
          limit: String(limit),
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      messages.push(...result.data);
      cursor = result.cursor?.next ?? undefined;
      // Stop on the first page that yields transcript content: a page of only
      // bookkeeping rows is skipped, and a page with content is the page the
      // caller asked for. Exhausted history ends the walk either way.
      if (toHistoryEntries(messages).length > 0 || cursor === undefined) {
        break;
      }
    }

    // The API is newest-first; a page handed to the transcript is oldest-first
    // within itself, and each assistant message keeps its own content order.
    const entries = messages
      .map((message) => toHistoryEntries([message]))
      .reverse()
      .flat();
    return {
      entries,
      hasOlder: cursor !== undefined,
      ...(cursor === undefined ? {} : { before: cursor }),
    };
  }

  /** Every user message the session holds, in conversation order. */
  async userMessages(): Promise<AgentUserMessage[]> {
    const messages: ApiMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const result = await this.api.page<ApiMessage>(
        `/session/${encodeURIComponent(this.engineId)}/message`,
        { limit: '100', ...(cursor === undefined ? {} : { cursor }) },
      );
      messages.push(...result.data);
      cursor = result.cursor?.next ?? undefined;
      if (cursor === undefined) {
        break;
      }
    }
    return toUserMessages(messages);
  }

  // ---------------------------------------------------------------- prompting

  /**
   * Sends a prompt. `followUp` queues behind the running turn (`queue`), while a
   * new/steer prompt is delivered into the session (`steer`) — OpenCode's own
   * names for the same two dispositions.
   *
   * Attachments become files the server can read (`files: [{ uri }]`): the wire
   * takes paths, not base64, for any media kind (image, video, audio, PDF). An
   * attachment that cannot be written is reported as a warning instead of being
   * silently dropped.
   *
   * Engine limitation, not Morse's: OpenCode's server rejects video/audio even
   * for models that declare the modality ("Only images, PDFs, or text files can
   * be attached here", anomalyco/opencode#21273, closed as not planned). Such
   * files still ride along as workspace files the model can read with its
   * tools, but native multimodal delivery is up to the engine.
   */
  async prompt(
    text: string,
    mode: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
  ): Promise<PromptDisposition> {
    const files = await this.materializeImages(images);
    const accepted = await this.api.post<{ delivery?: string }>(
      `/session/${encodeURIComponent(this.engineId)}/prompt`,
      {
        text: appendPinMentions(text, pins),
        ...(files.length === 0 ? {} : { files }),
        ...(mode === 'followUp' ? { delivery: 'queue' } : {}),
      },
    );
    return accepted?.delivery === 'queue' ? 'queued' : 'started';
  }

  /** Interrupts the running turn. A no-op turn answers `{interrupted:false}`. */
  async abort(): Promise<void> {
    await this.api.post(`/session/${encodeURIComponent(this.engineId)}/interrupt`);
  }

  /** Stops a child this session spawned, by the engine id its tool event named. */
  async abortChild(childSessionId: string): Promise<void> {
    if (!this.childRefs.has(childSessionId)) {
      return;
    }
    await this.api.post(`/session/${encodeURIComponent(childSessionId)}/interrupt`);
  }

  // ---------------------------------------------------------------- models

  /**
   * Replaces the agent-model map and the configured default from a catalog read.
   *
   * An empty catalog changes nothing: every caller treats it as a read that
   * failed or raced a starting project, and blanking the map would leave the
   * next refresh with nothing to resolve a model through.
   */
  private adoptCatalog(catalog: AgentCatalog): void {
    if (catalog.modes.length === 0) {
      return;
    }
    this.agentModels.clear();
    for (const [id, model] of catalog.models) {
      this.agentModels.set(id, model);
    }
    this.defaultMode = catalog.defaultMode;
  }

  /** Selects a catalog model, keeping the current level when that model offers it. */
  async setModel(model: ModelRef): Promise<void> {
    const apiModel = this.modelFor(model.provider, model.id);
    const variant =
      apiModel === undefined ? undefined : variantForLevel(apiModel, this.box.thinkingLevel);
    await this.api.post(`/session/${encodeURIComponent(this.engineId)}/model`, {
      model: {
        id: model.id,
        providerID: model.provider,
        ...(variant === undefined ? {} : { variant }),
      },
    });
    const ref = apiModel === undefined ? model : toModelRef(apiModel);
    this.mergeState({
      model: ref,
      availableThinkingLevels: thinkingLevelsOf(apiModel),
      thinkingLevel: thinkingLevelOf(apiModel, variant),
    });
    this.emitState(Date.now());
  }

  /** Selects a reasoning level; only a variant the model declares is accepted. */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const selected = this.selectedModel();
    const variant = variantForLevel(selected, level);
    if (selected === undefined || variant === undefined) {
      throw new UnsupportedByHostError(
        `The selected OpenCode model does not offer the "${level}" thinking level.`,
      );
    }
    const ref = toModelRef(selected);
    await this.api.post(`/session/${encodeURIComponent(this.engineId)}/model`, {
      model: { id: ref.id, providerID: ref.provider, variant },
    });
    this.mergeState({ thinkingLevel: level });
    this.emitState(Date.now());
  }

  // ---------------------------------------------------------------- modes

  /**
   * Switches the session's agent. OpenCode owns the record, so the choice is
   * sent there rather than kept as a Morse-only field; the state follows.
   *
   * The new agent may be configured with another model, and a session that never
   * prompted has no model of its own to keep: re-reading the record is what names
   * the model the next step will actually use.
   */
  async setMode(mode: string): Promise<void> {
    const offered = this.box.availableModes ?? [];
    if (!offered.some((option) => option.id === mode)) {
      throw new UnsupportedByHostError(
        `The selected OpenCode configuration does not offer the "${mode}" mode.`,
      );
    }
    await this.api.post(`/session/${encodeURIComponent(this.engineId)}/agent`, {
      agent: mode,
    });
    await this.refreshState();
    // The reader's choice wins over a record that may still read the old agent:
    // the POST above settled it.
    this.mergeState({ mode });
    this.emitState(Date.now());
  }

  /**
   * Re-reads the primary agents, the configured default and every other catalog.
   * The current mode is kept even when the configuration no longer lists it:
   * OpenCode may still have it on the session, and forcing another would change
   * the conversation behind the reader's back.
   */
  async refreshModes(): Promise<void> {
    // The mode picker also shows the model and the commands of the selected
    // agent, so one read of the whole config is what keeps the composer coherent.
    await this.refreshConfig();
  }

  // ---------------------------------------------------------------- catalogs

  /**
   * Re-reads every catalog the composer shows and replaces the maps behind them.
   *
   * This is the manual reload's path: a config file OpenCode has just re-read
   * can add, rename or remove models, agents, commands and skills, and a warm
   * session must see that without being reopened. A still-valid model keeps its
   * place with the fresh entry's name, limits and variants; one the catalog no
   * longer lists is replaced by the current agent's model or the server's own
   * default, and the panel names no model when neither can serve it.
   *
   * Every read is best effort. OpenCode always ships models, primary agents and
   * its built-in commands, so an empty answer is a read that failed or raced a
   * starting project, not a configuration without them: a list is only replaced
   * by a non-empty answer, and the last good picker survives a transient failure.
   * The current mode is never dropped for an empty modes list either.
   */
  async refreshConfig(): Promise<void> {
    const directory = this.box.workspace.cwd;
    const [models, commandCatalog, catalog] = await Promise.all([
      this.api
        .get<ApiModel[]>('/model', { 'location[directory]': directory })
        .catch((error: unknown): ApiModel[] => {
          this.log.warn('Could not read the OpenCode model catalog', error);
          return [];
        }),
      readCommandCatalog(this.api, directory, this.log, this.configDir),
      readAgentCatalog(this.api, directory, this.log),
    ]);
    if (this.disposed) {
      return;
    }
    const patch: Partial<AgentSessionState> = {};
    if (models.length > 0) {
      // Replace the map first: the state refresh below resolves its model through it.
      this.models.clear();
      for (const model of models) {
        this.models.set(modelKey(model), model);
      }
      patch.availableModels = toModelRefs(models);
    }
    if (commandCatalog.complete && commandCatalog.commands.length > 0) {
      patch.availableCommands = [...commandCatalog.commands];
    }
    if (catalog.modes.length > 0) {
      this.adoptCatalog(catalog);
      patch.availableModes = catalog.modes;
      if (this.box.mode === undefined) {
        const mode = defaultModeId(catalog.modes);
        if (mode !== undefined) {
          patch.mode = mode;
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      this.mergeState(patch);
      this.emitState(Date.now());
    }

    // The session record carries the agent another client may have switched and
    // the usage the reload did not touch; a fresh session's model resolves
    // through the catalog just replaced.
    await this.refreshState();

    // Whatever the panel names must be a model the picker offers — or nothing.
    // Keeping the last model is only honest after a *failed* read (the map was
    // kept); after a good one the catalog is the truth, so the resolution mirrors
    // `open`: the current model when `/model` still lists it, else the current
    // agent's model, else the server's own `/model/default` (appended when the
    // catalog does not list it), else no model at all.
    const current = this.box.model;
    if (current === undefined) {
      return;
    }
    const offered = (model: ApiModel): boolean =>
      (this.box.availableModels ?? []).some(
        (entry) => entry.provider === model.providerID && entry.id === model.id,
      );
    // A model the catalog still lists keeps its place; one it carries but does
    // not offer (disabled) does not, and the chain moves on to the agent's model.
    const listed = this.modelFor(current.provider, current.id);
    let chosen = listed !== undefined && offered(listed) ? listed : undefined;
    if (chosen === undefined && this.box.mode !== undefined) {
      const agentModel = this.agentModels.get(this.box.mode);
      const configured =
        agentModel === undefined
          ? undefined
          : this.modelFor(agentModel.providerID, agentModel.id);
      if (configured !== undefined && offered(configured)) {
        chosen = configured;
      }
    }
    if (chosen === undefined) {
      const serverDefault = await readDefaultModel(this.api, directory, this.log);
      if (serverDefault !== undefined) {
        chosen = this.modelFor(serverDefault.providerID, serverDefault.id) ?? serverDefault;
        if (!offered(chosen)) {
          // The server's own fallback may be missing from a stale catalog; append
          // it, exactly as `open` does, so the picker can name it.
          this.models.set(modelKey(chosen), chosen);
          this.mergeState({
            availableModels: [...(this.box.availableModels ?? []), toModelRef(chosen)],
          });
        }
      }
    }
    if (chosen === undefined) {
      this.mergeState({ model: undefined, availableThinkingLevels: [] });
      this.emitState(Date.now());
      return;
    }
    // A still-valid model keeps its place, but the fresh entry is the truth for
    // its name, limits and variants — including the level they leave available.
    this.mergeState({
      model: toModelRef(chosen),
      availableThinkingLevels: thinkingLevelsOf(chosen),
      thinkingLevel: thinkingLevelOf(chosen, variantForLevel(chosen, this.box.thinkingLevel)),
    });
    this.emitState(Date.now());
  }

  /** The model picker's refresh; every catalog is replaced by the same read. */
  async refreshModels(): Promise<void> {
    await this.refreshConfig();
  }

  /** The command palette's refresh; every catalog is replaced by the same read. */
  async refreshCommands(): Promise<void> {
    await this.refreshConfig();
  }

  // ---------------------------------------------------------------- fork / rewrite / clone

  /**
   * Forks before a user message: OpenCode creates a new engine session whose
   * history ends before that message, and this agent continues as that session.
   * The dropped prompt's text is returned for the composer, as the port promises.
   */
  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const text = await this.promptText(entryId);
    const forked = await this.api.post<ApiSessionInfo>(
      `/session/${encodeURIComponent(this.engineId)}/fork`,
      { before: entryId },
    );
    this.adoptSession(forked);
    await this.refreshState();
    return { text, cancelled: false };
  }

  /**
   * Edits in place: OpenCode stages a reversible boundary at the message, then
   * commits it, so that prompt and the turn after it leave the *same* session —
   * unlike `fork`, the id does not move and the old branch is not kept.
   */
  async rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const text = await this.promptText(entryId);
    const session = encodeURIComponent(this.engineId);
    await this.api.post(`/session/${session}/revert/stage`, { messageID: entryId });
    try {
      await this.api.post(`/session/${session}/revert/commit`);
    } catch (error: unknown) {
      // A stage restores the files at once; a failed commit must hand them back
      // rather than leave a half-applied boundary the user never asked for.
      await this.api.delete(`/session/${session}/revert`).catch(() => undefined);
      throw error;
    }
    await this.refreshState();
    return { text, cancelled: false };
  }

  /**
   * Branches at the tip: OpenCode copies the whole conversation into a new
   * engine session with no boundary, and this agent continues as it.
   */
  async clone(): Promise<{ cancelled: boolean }> {
    const forked = await this.api.post<ApiSessionInfo>(
      `/session/${encodeURIComponent(this.engineId)}/fork`,
    );
    this.adoptSession(forked);
    // The copy's record carries its own title and totals, so read it rather than
    // keep the session this agent was showing a moment ago.
    await this.refreshState();
    return { cancelled: false };
  }

  /**
   * Summarizes the context. The installed server accepts no instructions, so a
   * caller that passes them is told they were not sent — the compaction still
   * runs, because a silent no-op would be worse than a summary without guidance.
   */
  async compact(customInstructions?: string): Promise<void> {
    const instructions = customInstructions?.trim();
    if (instructions !== undefined && instructions.length > 0) {
      this.emit({
        type: 'agent/notice',
        at: Date.now(),
        level: 'warn',
        text: 'OpenCode does not accept custom compaction instructions; compacted without them.',
      });
    }
    const result = await this.api.post<ApiMessage>(
      `/session/${encodeURIComponent(this.engineId)}/compact`,
    );
    if (result?.status === 'failed') {
      const error = asRecord(result.error)?.['message'];
      this.emit({
        type: 'agent/notice',
        at: Date.now(),
        level: 'error',
        text: `Compaction failed${typeof error === 'string' ? `: ${error}` : '.'}`,
      });
    }
  }

  /**
   * Answers a pending form or permission request.
   *
   * The request id is the engine's own, so a reply can only reach the request it
   * was asked for. A form carries a keyed map (the whole form at once, as the
   * server expects); a permission carries the chosen decision. Cancelling is a
   * delete/reject, never an empty answer.
   */
  async respondToInteraction(response: AgentInteractionResponse): Promise<void> {
    const kind = this.pending.get(response.requestId);
    if (kind === undefined) {
      // Already settled (another client, a timeout): nothing to answer.
      return;
    }
    const session = encodeURIComponent(this.engineId);
    const request = encodeURIComponent(response.requestId);
    try {
      if (kind === 'form') {
        if (response.cancelled === true) {
          await this.api.delete(`/session/${session}/form/${request}`, {
            message: 'Cancelled in Morse.',
          });
        } else {
          await this.api.post(`/session/${session}/form/${request}/reply`, {
            answer: response.values ?? {},
          });
        }
      } else if (response.cancelled === true) {
        await this.api.post(`/session/${session}/permission/${request}/reply`, {
          decision: 'reject',
        });
      } else {
        const decision =
          response.value === 'once' || response.value === 'always' ? response.value : 'reject';
        await this.api.post(`/session/${session}/permission/${request}/reply`, {
          decision,
        });
      }
    } finally {
      this.announced.delete(response.requestId);
      this.pending.delete(response.requestId);
    }
  }

  /** Detaches from the stream and drops materialized images. Keeps the conversation. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const unsubscribe of this.childWatches.values()) {
      unsubscribe();
    }
    this.childWatches.clear();
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.clearListeners();
    // A session that is gone never blocks a config reload.
    this.guard?.forget(this.engineId);
    for (const path of this.imageFiles.splice(0)) {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- internals

  private reportChild(child: AgentChildSessionRef, running: boolean, at: number): void {
    if (this.disposed || this.childRunning.get(child.sessionId) === running) {
      return;
    }
    this.childRunning.set(child.sessionId, running);
    this.emit({ type: 'agent/child', at, childSession: child, running });
    if ([...this.childRunning.values()].some(Boolean) || this.box.streaming) {
      this.watchdog ??= setInterval(() => this.tickWatchdog(), CHILD_RECONCILE_MS);
    } else {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  /**
   * Re-reads the engine's active sessions once for all watched children. A
   * child missing from the list has ended: this settles a run whose idle frame
   * was lost, without waiting for another event that may never come.
   */
  private reconcileChildren(): void {
    const running = [...this.childRunning.entries()]
      .filter(([, live]) => live)
      .map(([id]) => id);
    if (running.length === 0 || this.reconcilingChildren !== undefined) {
      return;
    }
    const request = this.api
      .get<Record<string, unknown>>('/session/active')
      .then((active) => {
        if (active === undefined || this.disposed) {
          return;
        }
        for (const id of running) {
          if (!(id in active)) {
            const child = this.childRefs.get(id) ?? { sessionId: id };
            this.reportChild(child, false, Date.now());
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.reconcilingChildren === request) {
          this.reconcilingChildren = undefined;
        }
      });
    this.reconcilingChildren = request;
  }

  /** Periodic backstop for live work: reconcile statuses and revive a quiet stream. */
  private tickWatchdog(): void {
    if (this.disposed) {
      return;
    }
    if (!this.box.streaming && ![...this.childRunning.values()].some(Boolean)) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
      return;
    }
    this.reconcileChildren();
    void this.stream.restartIfStale(STREAM_STALE_MS);
  }

  /**
   * Listens to a spawned child's own session, so its run is reported after the
   * tool row closed: OpenCode's subagents always run in the background, and the
   * `task` call hands back the child's id within milliseconds. What the child's
   * events say about its liveness is folded into `agent/child` reports on this
   * session's stream; the child's record covers a start that happened before
   * the id was known.
   */
  private watchChild(child: AgentChildSessionRef): void {
    const id = child.sessionId;
    if (this.childWatches.has(id)) {
      return;
    }
    const report = (running: boolean, at: number): void => this.reportChild(child, running, at);
    this.childRefs.set(id, child);
    let live = false;
    this.childWatches.set(
      id,
      this.stream.subscribe(id, (event) => {
        const running = childRunningOf(event.type, event.data);
        if (running !== undefined) {
          live = true;
          report(running, event.created);
        }
      }),
    );
    void this.api
      .get<ApiSessionInfo>(`/session/${encodeURIComponent(id)}`)
      .then(
        (record) => {
          // A report from the stream is the fresher truth; the record only
          // covers a child that started before anything named it.
          if (!this.disposed && !live && this.childWatches.has(id) && sessionBusy(record) === true) {
            report(true, Date.now());
          }
        },
        () => undefined,
      );
  }

  private attach(): void {
    this.unsubscribe = this.stream.subscribe(this.engineId, (event) => this.handle(event));
  }

  /**
   * Continues this agent as the session the server just created — a fork, or a
   * clone with no boundary. The event source is keyed by engine id, so the
   * subscription has to move with it or the new branch would stream nothing.
   */
  private adoptSession(forked: ApiSessionInfo | undefined): void {
    if (forked === undefined || typeof forked.id !== 'string' || forked.id.length === 0) {
      throw new AgentUnavailableError('OpenCode did not return the forked session.');
    }
    const previous = this.engineId;
    this.engineId = forked.id;
    // The guard tracks turns by engine id, so the booking moves with the session
    // or a reload would wait on an id nobody answers for.
    this.guard?.forget(previous);
    this.guard?.setStreaming(this.engineId, this.box.streaming);
    this.mergeState({ sessionId: forked.id });
    this.unsubscribe?.();
    this.attach();
  }

  /**
   * Re-reads the command catalog until it stops growing, and repaints the
   * composer when it does.
   *
   * The first read on a session lands while OpenCode is still populating the
   * catalog (built-ins first, the project's `.opencode/commands` and skills a
   * second or two later), so without this the palette stays empty for the whole
   * session — the one a user opens right after the server boots.
   */
  private settleCommands(directory: string): void {
    void (async () => {
      for (let round = 0; round < COMMAND_SETTLE_ROUNDS; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
        if (this.disposed) {
          return;
        }
        const commands = await readAvailableCommands(
          this.api,
          directory,
          this.log,
          this.configDir,
        );
        if (this.disposed) {
          return;
        }
        if (commands.length > this.box.availableCommands.length) {
          this.patch({ availableCommands: commands }, Date.now());
          continue;
        }
        return;
      }
    })();
  }

  /**
   * Reads the server's own pending lists and announces anything not seen yet.
   *
   * The SSE stream is the primary source, but a form can outlive a connection (a
   * resumed session, a dropped stream, a request created just before a step
   * ended), so the agent polls on connect and at execution boundaries. The
   * `announced` set makes the two sources idempotent: whichever sees a request
   * first is the one that shows it once.
   */
  private syncInteractions(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.syncing !== undefined) {
      return this.syncing;
    }
    const session = encodeURIComponent(this.engineId);
    const run = Promise.all([
      this.api.get<ApiForm[]>(`/session/${session}/form`).catch((error: unknown): ApiForm[] => {
        this.log.debug('Could not list OpenCode forms', { error });
        return [];
      }),
      this.api
        .get<ApiPermissionRequest[]>(`/session/${session}/permission`)
        .catch((error: unknown): ApiPermissionRequest[] => {
          this.log.debug('Could not list OpenCode permission requests', {
            error,
          });
          return [];
        }),
    ])
      .then(([forms, permissions]) => {
        if (this.disposed) {
          return;
        }
        for (const form of forms) {
          this.announce(toFormRequest(form), 'form');
        }
        for (const permission of permissions) {
          this.announce(toPermissionRequest(permission), 'permission');
        }
      })
      .finally(() => {
        if (this.syncing === run) {
          this.syncing = undefined;
        }
      });
    this.syncing = run;
    return run;
  }

  /** Emits one interaction request, unless it was already shown. */
  private announce(
    request: AgentFormRequest | AgentSelectRequest,
    kind: 'form' | 'permission',
  ): void {
    if (this.announced.has(request.requestId)) {
      return;
    }
    this.announced.add(request.requestId);
    this.pending.set(request.requestId, kind);
    this.emit({ type: 'agent/interaction', at: Date.now(), request });
  }

  /** Releases a request another client settled. */
  private forget(requestId: string | undefined): void {
    if (requestId === undefined) {
      return;
    }
    this.announced.delete(requestId);
    this.pending.delete(requestId);
  }

  /** Folds one streamed event into state and the transcript. */
  private handle(event: OpenCodeEvent): void {
    if (this.disposed) {
      return;
    }
    const mapped = this.mapper.map(event);
    if (mapped.state !== undefined) {
      const patch = { ...mapped.state };
      const step = patch.model;
      if (step !== undefined) {
        // The step names the model actually serving this turn; the catalog
        // supplies its display name and the thinking levels it really offers.
        const apiModel = this.modelFor(step.provider, step.id);
        patch.model = apiModel === undefined ? step : toModelRef(apiModel);
        if (apiModel !== undefined) {
          const levels = thinkingLevelsOf(apiModel);
          patch.availableThinkingLevels = levels;
          // A step names the model, not the variant it runs with: the session's
          // own pick still applies while the same model serves the turn. Only a
          // model swap (or a pick its variants no longer offer) makes it moot.
          const current = this.box.model;
          const sameModel = current?.provider === step.provider && current.id === step.id;
          if (!sameModel || !levels.includes(this.box.thinkingLevel)) {
            patch.thinkingLevel = thinkingLevelOf(apiModel, undefined);
          }
        }
      }
      const previous = this.box.model;
      this.mergeState(patch);
      if (
        step !== undefined &&
        previous !== undefined &&
        (previous.provider !== step.provider || previous.id !== step.id)
      ) {
        // A different model than the one on screen took over (OpenCode falls
        // back silently when a configured model cannot be resolved); say so
        // instead of swapping the label unnoticed.
        this.emit({
          type: 'agent/notice',
          at: event.created,
          level: 'info',
          text: `The agent is serving this conversation with ${step.provider}/${step.id}.`,
        });
      }
    }
    if (event.type === 'stream.fatal') {
      // A dead stream is not a running turn any more; the fatal event explains
      // why the transcript stops.
      this.mergeState({ streaming: false });
    }
    // Publish the state before the events that end a run. Host consumers read it
    // at run-end to decide whether the next queued prompt may go out; announcing
    // the end while `streaming` is still true left queues stuck until another
    // event happened to wake them.
    if (mapped.state !== undefined || event.type === 'stream.fatal') {
      this.emitState(event.created);
    }
    for (const mappedEvent of mapped.events) {
      if (mappedEvent.type === 'agent/interaction') {
        const kind = mappedEvent.request.kind === 'form' ? 'form' : 'permission';
        this.announced.add(mappedEvent.request.requestId);
        this.pending.set(mappedEvent.request.requestId, kind);
      }
      if ('childSession' in mappedEvent && mappedEvent.childSession !== undefined) {
        this.watchChild(mappedEvent.childSession);
      }
      this.emit(mappedEvent);
    }
    const title = asRecord(event.data)['title'];
    if (typeof title === 'string' && title.length > 0) {
      this.mergeState({ sessionTitle: title });
      this.emitState(event.created);
    }
    if (
      event.type === 'form.replied' ||
      event.type === 'form.cancelled' ||
      event.type === 'permission.replied'
    ) {
      // Another client may have answered a request this agent is holding.
      const data = asRecord(event.data);
      this.forget(
        asString(asRecord(data['form'])?.['id']) ??
          asString(data['formID']) ??
          asString(data['requestID']) ??
          asString(data['id']),
      );
    }
    if (event.type === 'stream.connected') {
      // Frames may have been lost in the gap: a child's idle can be one of
      // them, so re-read the engine's active list before trusting old marks.
      void this.reconcileChildren();
    }
    if (
      event.type === 'stream.connected' ||
      mapped.events.some((mappedEvent) => mappedEvent.type === 'agent/run-end')
    ) {
      // The server names sessions and records their usage; a reconnect or a
      // finished run is when the view most needs to re-read those.
      void this.refreshState();
    }
    if (
      event.type === 'stream.connected' ||
      event.type === 'session.execution.started' ||
      event.type === 'session.execution.succeeded' ||
      event.type === 'session.execution.failed' ||
      event.type === 'session.execution.interrupted' ||
      event.type === 'session.execution.cancelled' ||
      event.type === 'session.execution.aborted'
    ) {
      // A form asked during a step may have been emitted before a reconnect, or
      // just before the step settled: the pending lists are the backstop.
      void this.syncInteractions();
    }
  }

  /** Re-reads the server's session record into the state, without failing the run. */
  private refreshState(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.refreshing !== undefined) {
      return this.refreshing;
    }
    const run = this.loadServerState()
      .catch((error: unknown) => {
        this.log.warn('Could not refresh the OpenCode session state', {
          error,
        });
      })
      .finally(() => {
        if (this.refreshing === run) {
          this.refreshing = undefined;
        }
      });
    this.refreshing = run;
    return run;
  }

  private async loadServerState(): Promise<void> {
    // A session opened while the server was still starting can miss its primary
    // agents; the mode picker then never appears. Re-read them on a refresh
    // (connect or run end) until one lands, and leave a known list alone.
    const modesMissing = (this.box.availableModes ?? []).length === 0;
    const [session, metrics, catalog] = await Promise.all([
      this.api.get<ApiSessionInfo>(`/session/${encodeURIComponent(this.engineId)}`),
      // Resuming has no step event to report the last answer, so the ring would
      // stay empty until the reader prompts again. This is the one read that
      // makes an opened conversation look like a live one — and counts and
      // speed ride along, so one walk feeds the whole usage panel.
      this.usageMetrics().catch((error: unknown) => {
        this.log.warn('Could not read the OpenCode session metrics', { error });
        return undefined;
      }),
      modesMissing
        ? readAgentCatalog(this.api, this.box.workspace.cwd, this.log)
        : Promise.resolve(undefined),
    ]);
    if (this.disposed) {
      return;
    }
    // A server that answered 204 has no record to fold in; keep what we have
    // rather than reporting a session that lost its title and model.
    if (session === undefined || typeof session.id !== 'string') {
      return;
    }
    const apiModel =
      session.model === undefined
        ? this.fallbackModelFor(session.agent ?? this.defaultMode)
        : this.modelFor(session.model.providerID, session.model.id);
    const patch: Partial<AgentSessionState> = {};
    if (typeof session.title === 'string' && session.title.length > 0) {
      patch.sessionTitle = session.title;
    }
    if (typeof session.agent === 'string' && session.agent.length > 0) {
      // Another OpenCode client may have switched the agent (its Tab key); the
      // server's record is the truth, and Morse follows it.
      patch.mode = session.agent;
    }
    if (apiModel !== undefined) {
      patch.model = toModelRef(apiModel);
      patch.availableThinkingLevels = thinkingLevelsOf(apiModel);
      // The server is the truth for the variant: another client may have moved it.
      patch.thinkingLevel = thinkingLevelOf(apiModel, session.model?.variant);
    }
    const usage = toTokenUsage(session.tokens);
    if (usage !== undefined) {
      patch.usage = usage;
    }
    if (metrics !== undefined) {
      if (metrics.lastUsage !== undefined) {
        patch.lastUsage = metrics.lastUsage;
      }
      patch.counts = metrics.counts;
      if (metrics.speed !== undefined) {
        patch.speed = metrics.speed;
      }
    }
    if (catalog !== undefined && catalog.modes.length > 0) {
      this.adoptCatalog(catalog);
      patch.availableModes = catalog.modes;
      if (this.box.mode === undefined) {
        const mode = defaultModeId(catalog.modes);
        if (mode !== undefined) {
          patch.mode = mode;
        }
      }
    }
    if (typeof session.cost === 'number' && Number.isFinite(session.cost)) {
      patch.costUsd = session.cost;
    }
    if (Object.keys(patch).length > 0) {
      this.mergeState(patch);
      this.emitState(Date.now());
    }
  }

  /**
   * One walk of the stored message list, newest-first: the newest finished
   * answer's tokens for the context window and the last-message panel, plus
   * the session's message/step counts and speed totals for the usage panel.
   */
  private async usageMetrics(): Promise<{
    lastUsage?: TokenUsage;
    counts: SessionCounts;
    speed?: SessionSpeed;
  }> {
    const messages: ApiMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < USAGE_WALK_PAGES; page += 1) {
      const result = await this.api.page<ApiMessage>(
        `/session/${encodeURIComponent(this.engineId)}/message`,
        {
          limit: String(USAGE_PAGE_LIMIT),
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      messages.push(...result.data);
      cursor = result.cursor?.next ?? undefined;
      if (cursor === undefined) {
        break;
      }
    }
    const newest = messages.find(
      (message) => message.type === 'assistant' && message.tokens !== undefined,
    );
    return {
      lastUsage: toTokenUsage(newest?.tokens),
      counts: sessionCountsOf(messages),
      speed: sessionSpeedOf(messages),
    };
  }

  private selectedModel(): ApiModel | undefined {
    const model = this.box.model;
    return model === undefined ? undefined : this.modelFor(model.provider, model.id);
  }

  /**
   * The model a session with no recorded one would use: the configured model of
   * the agent it runs, when the catalog knows it, else whatever the state
   * already shows (which is how a `/model/default` seed survives a refresh).
   */
  private fallbackModelFor(mode: string | undefined): ApiModel | undefined {
    const agentModel = mode === undefined ? undefined : this.agentModels.get(mode);
    const configured =
      agentModel === undefined ? undefined : this.modelFor(agentModel.providerID, agentModel.id);
    return configured ?? this.selectedModel();
  }

  private modelFor(provider: string, id: string): ApiModel | undefined {
    return this.models.get(`${provider}/${id}`);
  }

  /** The dropped prompt's text, for restoring the composer after a fork. */
  private async promptText(entryId: string): Promise<string> {
    const message = await this.api
      .get<ApiMessage>(
        `/session/${encodeURIComponent(this.engineId)}/message/${encodeURIComponent(entryId)}`,
      )
      .catch(() => undefined);
    return message?.text ?? '';
  }

  /**
   * Writes base64 attachments where the server can read them and returns `file:` URIs.
   *
   * The files live for the session's lifetime (not just the request): a queued
   * follow-up reads its attachment when *it* runs, which can be after the prompt
   * call returned. Disposing the session removes them.
   */
  private async materializeImages(images: PromptImage[] | undefined): Promise<{ uri: string }[]> {
    if (images === undefined || images.length === 0) {
      return [];
    }
    const directory = join(tmpdir(), 'morse-opencode', `${process.pid}`);
    const files: { uri: string }[] = [];
    for (const image of images) {
      try {
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${randomUUID()}${extensionOf(image.mimeType)}`);
        await writeFile(path, Buffer.from(image.data, 'base64'));
        this.imageFiles.push(path);
        files.push({ uri: pathToFileURL(path).href });
      } catch (error: unknown) {
        this.log.warn('Could not materialize an attachment for OpenCode', error);
        this.emit({
          type: 'agent/notice',
          at: Date.now(),
          level: 'warn',
          text: 'An attachment could not be sent to OpenCode; it was omitted.',
        });
      }
    }
    return files;
  }
}
