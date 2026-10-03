import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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
      availableCommands: await buildCommandList(commands?.commands, this.commandContext()),
      streaming: state.isStreaming === true,
    };
    this.ready = true;
    await this.refreshStats();
    this.emit({ type: 'agent/ready', at: this.now(), state: this.snapshotState() });
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
    this.sessionState = {
      ...this.sessionState,
      availableCommands: await buildCommandList(commands?.commands, this.commandContext()),
    };
    this.emit({ type: 'agent/state', at: this.now(), state: this.snapshotState() });
  }

  /** Where a command list is rebuilt from: the session's workspace and env. */
  private commandContext(): CommandContext {
    return { cwd: this.options.workspace.cwd, env: this.options.env };
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

/**
 * pi lists a prompt template in `get_commands` but does not send its body over
 * RPC, and it does not notice a file added after spawn. Read the file directly —
 * both for the templates pi named and for the ones Morse finds on disk. Best
 * effort: an unreadable file is left out rather than offered as a dead command.
 */
async function readTemplateFile(path: string | undefined): Promise<string | undefined> {
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** What a command list is rebuilt from: the workspace and the pi environment. */
export interface CommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
}

/** The subset of a `get_commands` entry the command list cares about. */
export interface CommandListInput {
  name?: string;
  description?: string;
  source?: string;
  sourceInfo?: { path?: string; scope?: string };
}

/**
 * The palette's command list, rebuilt from disk. pi only exposes the templates
 * it loaded at spawn (`get_commands` is a cache), so this also re-reads every
 * template file and scans the conventional prompt directories — that is what
 * makes a template added, changed or deleted since spawn show up without a pi
 * reload.
 *
 * pi's own list stays the source for extension and skill commands, and for
 * prompt templates that live outside the conventional directories (packages,
 * explicit paths); a listed template whose file is gone is dropped.
 */
export async function buildCommandList(
  items: CommandListInput[] | undefined,
  context: CommandContext,
): Promise<AgentCommand[]> {
  const commands: AgentCommand[] = [];
  const seen = new Set<string>();
  let projectTrusted = false;

  for (const item of items ?? []) {
    if (typeof item.name !== 'string' || item.name.trim().length === 0) {
      continue;
    }
    const source = toCommandSource(item.source);
    if (source !== 'prompt') {
      commands.push({ name: item.name, description: item.description, source });
      seen.add(item.name);
      continue;
    }
    if (item.sourceInfo?.scope === 'project') {
      projectTrusted = true;
    }
    const template = await readTemplateFile(item.sourceInfo?.path);
    if (template === undefined) {
      // The file pi listed is gone: hide it rather than offer a dead command.
      continue;
    }
    commands.push({
      name: item.name,
      // Prefer the freshly parsed description so an edited frontmatter reflects
      // too; pi's cached description is the fallback.
      description: promptDescription(template) ?? item.description,
      source,
      template,
    });
    seen.add(item.name);
  }

  for (const dir of await promptDirs(projectTrusted, context)) {
    for (const file of await listPromptFiles(dir)) {
      if (seen.has(file.name)) {
        continue;
      }
      const template = await readTemplateFile(file.path);
      if (template === undefined) {
        continue;
      }
      commands.push({
        name: file.name,
        description: promptDescription(template),
        source: 'prompt',
        template,
      });
      seen.add(file.name);
    }
  }
  return commands;
}

/**
 * Directories Morse re-scans for prompt templates: the user's global prompts,
 * and the project's — the latter only once that project is trusted, exactly as
 * pi gates project resources.
 */
async function promptDirs(projectTrusted: boolean, context: CommandContext): Promise<string[]> {
  const dirs = [join(agentDir(context.env), 'prompts')];
  if (projectTrusted || (await isProjectTrusted(context.cwd, context.env))) {
    dirs.push(resolve(context.cwd, '.pi', 'prompts'));
  }
  return dirs;
}

/** pi's agent config directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). */
function agentDir(env: NodeJS.ProcessEnv | undefined): string {
  const configured = env?.PI_CODING_AGENT_DIR?.trim();
  return configured && configured.length > 0
    ? expandHome(configured)
    : join(homedir(), '.pi', 'agent');
}

function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * pi records project trust in `<agentDir>/trust.json` as `{ "<cwd>": true }`.
 * The project prompt directory is only scanned when that says yes, so an
 * untrusted checkout cannot inject a template into the palette.
 */
async function isProjectTrusted(cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<boolean> {
  try {
    const raw = await readFile(join(agentDir(env), 'trust.json'), 'utf8');
    const decisions = JSON.parse(raw) as Record<string, unknown>;
    return decisions[cwd] === true || decisions[resolve(cwd)] === true;
  } catch {
    return false;
  }
}

/** Direct `.md` children of a prompt directory — pi loads direct children only. */
async function listPromptFiles(dir: string): Promise<{ name: string; path: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) {
      continue;
    }
    const path = join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = (await stat(path)).isFile();
      } catch {
        continue;
      }
    }
    if (isFile) {
      files.push({ name: basename(entry.name, '.md'), path });
    }
  }
  return files;
}

/**
 * What the palette prints for a scanned template: pi's `description` frontmatter,
 * or the first non-empty body line, truncated the way pi truncates it.
 */
function promptDescription(raw: string): string | undefined {
  let body = raw;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (frontmatter !== null) {
    const described = /^description:[ \t]*(.*)$/m.exec(frontmatter[1]);
    if (described !== null) {
      const value = unquote(described[1].trim());
      if (value.length > 0) {
        return value;
      }
    }
    body = raw.slice(frontmatter[0].length);
  }
  const firstLine = body.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    return undefined;
  }
  const trimmed = firstLine.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
}

function unquote(value: string): string {
  const match = /^(['"])([\s\S]*)\1$/.exec(value);
  return match === null ? value : match[2];
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
