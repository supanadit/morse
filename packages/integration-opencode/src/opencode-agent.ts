import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  Session,
  type AgentCommand,
  type AgentForkMessage,
  type AgentFormRequest,
  type AgentHistoryPage,
  type AgentSelectRequest,
  type AgentInteractionResponse,
  type AgentMode,
  type AgentSessionState,
  type ChatPin,
  type ModelRef,
  type PromptDisposition,
  type PromptImage,
  type PromptMode,
  type ThinkingLevel,
  type WorkspaceRef,
} from '@morse/agent';
import { AgentUnavailableError, UnsupportedByHostError, type MorseLogger } from '@morse/system';
import type { OpenCodeApi } from './internal/client.js';
import { defaultModeId, readAgentModes, readDefaultModel } from './internal/catalog.js';
import { OpenCodeEventMapper, toTokenUsage } from './internal/event-mapping.js';
import type { OpenCodeEvent, OpenCodeEventStream } from './internal/event-stream.js';
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
  toForkMessages,
  toHistoryEntries,
  type ApiMessage,
} from './internal/message-mapping.js';
import {
  toFormRequest,
  toPermissionRequest,
  type ApiForm,
  type ApiPermissionRequest,
} from './internal/form-mapping.js';

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

/** The `Session.Info` fields this adapter reads. */
export interface ApiSessionInfo {
  id: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: unknown;
  outcome?: string;
  time?: { created?: number; updated?: number; idle?: number; viewed?: number; archived?: number };
  location?: { directory?: string };
  /** Set when this session was forked from another, with the engine id it came from. */
  fork?: { sessionID?: string; boundary?: unknown };
}

interface ApiCommand {
  name?: string;
  description?: string;
}

interface ApiSkill {
  id?: string;
  name?: string;
  description?: string;
}

/** How many message pages `history`/`forkMessages` will read before giving up. */
const MAX_HISTORY_PAGES = 20;
/** `history`'s page size in messages when the caller does not name one. */
const DEFAULT_HISTORY_LIMIT = 40;

export interface OpenCodeAgentOptions {
  api: OpenCodeApi;
  stream: OpenCodeEventStream;
  workspace: WorkspaceRef;
  logger: MorseLogger;
  /** Attach to a persisted engine session instead of creating one. */
  sessionId?: string;
  /** The mode a newly created session should start in. Ignored when attaching. */
  mode?: string;
}

export class OpenCodeAgent extends Session {
  readonly kind = 'opencode';

  private readonly api: OpenCodeApi;
  private readonly stream: OpenCodeEventStream;
  private readonly log: MorseLogger;
  private readonly mapper = new OpenCodeEventMapper();
  private readonly models = new Map<string, ApiModel>();
  private readonly imageFiles: string[] = [];
  private engineId: string;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  /** A refresh in flight; another request for one is folded into it. */
  private refreshing: Promise<void> | undefined;
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
    this.engineId = session.id;
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
    const [models, commands, modes] = await Promise.all([
      options.api
        .get<ApiModel[]>('/model', { directory })
        .catch((error: unknown): ApiModel[] => {
          options.logger.warn('Could not read the OpenCode model catalog', error);
          return [];
        }),
      readAvailableCommands(options.api, directory, options.logger),
      readAgentModes(options.api, directory, options.logger),
    ]);
    // A fresh session has no model until its first prompt, so read the one the
    // server would pick. It may not be in the catalog a stale server returned;
    // append it so the picker can name it.
    const defaultModel =
      session.model === undefined
        ? await readDefaultModel(options.api, directory, options.logger)
        : undefined;
    const catalogModels =
      defaultModel === undefined ||
      models.some(
        (model) =>
          model.providerID === defaultModel.providerID && model.id === defaultModel.id,
      )
        ? models
        : [...models, defaultModel];

    const agent = new OpenCodeAgent(
      options,
      session,
      initialStateOf(session, options.workspace, catalogModels, commands, modes, defaultModel),
    );
    for (const model of catalogModels) {
      agent.models.set(modelKey(model), model);
    }
    agent.attach();
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
    const limit = options.limit !== undefined && options.limit > 0 ? options.limit : DEFAULT_HISTORY_LIMIT;
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

  /** Every user prompt the session holds, in conversation order, for forking. */
  async forkMessages(): Promise<AgentForkMessage[]> {
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
    return toForkMessages(messages);
  }

  // ---------------------------------------------------------------- prompting

  /**
   * Sends a prompt. `followUp` queues behind the running turn (`queue`), while a
   * new/steer prompt is delivered into the session (`steer`) — OpenCode's own
   * names for the same two dispositions.
   *
   * Images become files the server can read (`files: [{ uri }]`): the wire takes
   * paths, not base64. An image that cannot be written is reported as a warning
   * instead of being silently dropped.
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

  // ---------------------------------------------------------------- models

  /** Selects a catalog model, keeping the current level when that model offers it. */
  async setModel(model: ModelRef): Promise<void> {
    const apiModel = this.modelFor(model.provider, model.id);
    const variant = apiModel === undefined ? undefined : variantForLevel(apiModel, this.box.thinkingLevel);
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
   */
  async setMode(mode: string): Promise<void> {
    const offered = this.box.availableModes ?? [];
    if (!offered.some((option) => option.id === mode)) {
      throw new UnsupportedByHostError(
        `The selected OpenCode configuration does not offer the "${mode}" mode.`,
      );
    }
    await this.api.post(`/session/${encodeURIComponent(this.engineId)}/agent`, { agent: mode });
    this.mergeState({ mode });
    this.emitState(Date.now());
  }

  /**
   * Re-reads the primary agents and the configured default. The current mode is
   * kept even when the configuration no longer lists it: OpenCode may still have
   * it on the session, and forcing another would change the conversation behind
   * the reader's back.
   */
  async refreshModes(): Promise<void> {
    const modes = await readAgentModes(this.api, this.box.workspace.cwd, this.log);
    const patch: Partial<AgentSessionState> = { availableModes: modes };
    if (this.box.mode === undefined) {
      const mode = defaultModeId(modes);
      if (mode !== undefined) {
        patch.mode = mode;
      }
    }
    this.mergeState(patch);
    this.emitState(Date.now());
  }

  // ---------------------------------------------------------------- fork / compact

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
    if (forked === undefined || typeof forked.id !== 'string' || forked.id.length === 0) {
      throw new AgentUnavailableError('OpenCode did not return the forked session.');
    }
    this.engineId = forked.id;
    this.mergeState({ sessionId: forked.id });
    // The event source is keyed by engine id, so a fork must move the
    // subscription with it or the new branch would stream nothing.
    this.unsubscribe?.();
    this.attach();
    await this.refreshState();
    return { text, cancelled: false };
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
    const result = await this.api.post<ApiMessage>(`/session/${encodeURIComponent(this.engineId)}/compact`);
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
          await this.api.delete(`/session/${session}/form/${request}`, { message: 'Cancelled in Morse.' });
        } else {
          await this.api.post(`/session/${session}/form/${request}/reply`, {
            answer: response.values ?? {},
          });
        }
      } else if (response.cancelled === true) {
        await this.api.post(`/session/${session}/permission/${request}/reply`, { decision: 'reject' });
      } else {
        const decision =
          response.value === 'once' || response.value === 'always' ? response.value : 'reject';
        await this.api.post(`/session/${session}/permission/${request}/reply`, { decision });
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
    this.clearListeners();
    for (const path of this.imageFiles.splice(0)) {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- internals

  private attach(): void {
    this.unsubscribe = this.stream.subscribe(this.engineId, (event) => this.handle(event));
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
          this.log.debug('Could not list OpenCode permission requests', { error });
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
      this.mergeState(mapped.state);
    }
    if (event.type === 'stream.fatal') {
      // A dead stream is not a running turn any more; the fatal event explains
      // why the transcript stops.
      this.mergeState({ streaming: false });
    }
    for (const mappedEvent of mapped.events) {
      if (mappedEvent.type === 'agent/interaction') {
        const kind = mappedEvent.request.kind === 'form' ? 'form' : 'permission';
        this.announced.add(mappedEvent.request.requestId);
        this.pending.set(mappedEvent.request.requestId, kind);
      }
      this.emit(mappedEvent);
    }
    if (mapped.state !== undefined || event.type === 'stream.fatal') {
      this.emitState(event.created);
    }
    const title = asRecord(event.data)['title'];
    if (typeof title === 'string' && title.length > 0) {
      this.mergeState({ sessionTitle: title });
      this.emitState(event.created);
    }
    if (event.type === 'form.replied' || event.type === 'form.cancelled' || event.type === 'permission.replied') {
      // Another client may have answered a request this agent is holding.
      const data = asRecord(event.data);
      this.forget(
        asString(asRecord(data['form'])?.['id']) ??
          asString(data['formID']) ??
          asString(data['requestID']) ??
          asString(data['id']),
      );
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
        this.log.warn('Could not refresh the OpenCode session state', { error });
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
    const session = await this.api.get<ApiSessionInfo>(
      `/session/${encodeURIComponent(this.engineId)}`,
    );
    if (this.disposed) {
      return;
    }
    const apiModel = session.model === undefined
      ? this.selectedModel()
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
    if (typeof session.cost === 'number' && Number.isFinite(session.cost)) {
      patch.costUsd = session.cost;
    }
    if (Object.keys(patch).length > 0) {
      this.mergeState(patch);
      this.emitState(Date.now());
    }
  }

  private selectedModel(): ApiModel | undefined {
    const model = this.box.model;
    return model === undefined ? undefined : this.modelFor(model.provider, model.id);
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
   * Writes base64 images where the server can read them and returns `file:` URIs.
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
        this.log.warn('Could not materialize an image attachment for OpenCode', error);
        this.emit({
          type: 'agent/notice',
          at: Date.now(),
          level: 'warn',
          text: 'An image attachment could not be sent to OpenCode; it was omitted.',
        });
      }
    }
    return files;
  }
}

function initialStateOf(
  session: ApiSessionInfo,
  workspace: WorkspaceRef,
  models: readonly ApiModel[],
  commands: readonly AgentCommand[],
  modes: readonly AgentMode[],
  defaultModel: ApiModel | undefined,
): AgentSessionState {
  const apiModel =
    session.model === undefined
      ? defaultModel
      : models.find(
          (model) =>
            model.providerID === session.model?.providerID && model.id === session.model?.id,
        );
  const model = apiModel === undefined ? modelRefOf(session.model) : toModelRef(apiModel);
  const usage = toTokenUsage(session.tokens);
  const directory = session.location?.directory;
  // A session created without an agent has none on its record until the first
  // prompt; report the default the configuration resolves so the picker has a
  // current choice. A session that already names one keeps it even if the
  // configuration no longer lists it.
  const mode = session.agent ?? defaultModeId(modes);
  return {
    sessionId: session.id,
    ...(session.title === undefined ? {} : { sessionTitle: session.title }),
    workspace: {
      cwd: directory === undefined || directory.length === 0 ? workspace.cwd : directory,
      name: directory === undefined || directory.length === 0 ? workspace.name : baseName(directory),
    },
    ...(model === undefined ? {} : { model }),
    thinkingLevel: thinkingLevelOf(apiModel, session.model?.variant),
    availableModels: toModelRefs(models),
    availableThinkingLevels: thinkingLevelsOf(apiModel),
    availableCommands: [...commands],
    ...(mode === undefined ? {} : { mode }),
    ...(modes.length === 0 ? {} : { availableModes: [...modes] }),
    streaming: false,
    ...(usage === undefined ? {} : { usage }),
    ...(typeof session.cost === 'number' && Number.isFinite(session.cost)
      ? { costUsd: session.cost }
      : {}),
  };
}

function modelRefOf(model: ApiSessionInfo['model']): ModelRef | undefined {
  if (model?.id === undefined || model.providerID === undefined) {
    return undefined;
  }
  return { provider: model.providerID, id: model.id, name: model.id };
}

/** The composer's palette: OpenCode commands (prompt templates) and skills. */
export async function readAvailableCommands(
  api: OpenCodeApi,
  directory: string,
  logger: MorseLogger,
): Promise<AgentCommand[]> {
  const [commands, skills] = await Promise.all([
    api
      .get<ApiCommand[]>('/command', { directory })
      .catch((error: unknown): ApiCommand[] => {
        logger.warn('Could not read the OpenCode command catalog', error);
        return [];
      }),
    api
      .get<ApiSkill[]>('/skill', { directory })
      .catch((error: unknown): ApiSkill[] => {
        logger.warn('Could not read the OpenCode skill catalog', error);
        return [];
      }),
  ]);
  const entries: AgentCommand[] = [];
  for (const command of commands) {
    if (typeof command.name !== 'string' || command.name.length === 0) {
      continue;
    }
    entries.push({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      source: 'prompt',
    });
  }
  for (const skill of skills) {
    const name = skill.name ?? skill.id;
    if (name === undefined || name.length === 0) {
      continue;
    }
    entries.push({
      name,
      ...(skill.description === undefined ? {} : { description: skill.description }),
      source: 'skill',
    });
  }
  return entries;
}

/**
 * Pins become `@path[:start-end]` mentions appended to the prompt, exactly as the
 * pi adapter renders them. OpenCode's wire takes prose, so this is the honest
 * representation of "the agent should read this range".
 */
export function appendPinMentions(text: string, pins: ChatPin[] | undefined): string {
  if (pins === undefined || pins.length === 0) {
    return text;
  }
  const mentions = pins
    .map((pin) => {
      if (pin.startLine === undefined) {
        return [`@${pin.path}`, ...noteLines(pin.note)].join('\n');
      }
      const end = pin.endLine ?? pin.startLine;
      return [`@${pin.path}:${pin.startLine}-${end}`, ...noteLines(pin.note)].join('\n');
    })
    .join('\n');
  const prose = text.trim();
  return prose.length > 0 ? `${prose}\n\n${mentions}` : mentions;
}

function noteLines(note: string | undefined): string[] {
  const trimmed = note?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? []
    : trimmed.split('\n').map((line) => `  > ${line}`);
}

/** The file extension an uploaded image gets, from its media type. */
function extensionOf(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.img';
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part.length > 0).at(-1) ?? path;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
