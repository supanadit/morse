import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentFormRequest,
  AgentFormValue,
  AgentGateway,
  AgentGatewayFactory,
  AgentInteractionRequest,
  AgentInteractionResponse,
  ModelRef,
  PromptDisposition,
  WorkspaceRef,
} from '@morse/agent';
import type {
  BotAuthor,
  BotConfig,
  BotConversationSummary,
  BotCreateInput,
  BotGroupCreateInput,
  BotProviderCredentialInput,
  BotRoutingState,
  BotSummary,
  BotTranscriptEntry,
  BotUpdateInput,
} from '@morse/protocol';
import { UnsupportedByHostError } from '../errors.js';
import type { MorseLogger } from '../logger.js';
import { mentionTokens, parseMentions } from './mentions.js';
import { BotTranscriptStore, TRANSCRIPT_PAGE_SIZE, type TranscriptPage } from './transcripts.js';
import { discoverOpenAiCompatibleModels } from './providers.js';
import type { BotProviderModel } from './types.js';
import {
  dmConversationId,
  loadBotRegistry,
  newGroupId,
  saveBotRegistry,
  writeBotIdentity,
} from './store.js';
import type {
  BotEngineCapabilities,
  BotEngineConfig,
  BotEngineLayout,
  BotEngineState,
  BotRecord,
  BotRegistryFile,
  ConversationRecord,
  GroupRecord,
} from './types.js';

/**
 * Bot mode's core: the roster of isolated bots, the conversations between them,
 * and the routing middleman that turns one human message into a bounded round of
 * bot replies.
 *
 * The service is engine-agnostic by rule: engines arrive as `BotEngineAdapter`s
 * the host constructs, so nothing here names one. Everything that persists goes
 * through `store.ts`, which keeps `registry.json` single-writer and atomic.
 */

/**
 * The factory an engine adapter hands the service. Engine integrations may own a
 * long-lived server (OpenCode's is one per bot), so a factory that has a
 * `dispose` must be torn down wherever the service is done with it.
 */
export type BotGatewayFactory = AgentGatewayFactory & { dispose?(): Promise<void> };

export interface BotEngineAdapter {
  /** Stable engine kind, the value `BotRecord.engineKind` carries. */
  kind: string;
  capabilities: BotEngineCapabilities;
  /**
   * A factory confined to one bot's directory. Built once per bot and cached:
   * an integration may start a long-lived engine server in here, so a second
   * call would start a second server for the same bot.
   */
  createFactory(botRoot: string, env: NodeJS.ProcessEnv): BotGatewayFactory;
  /**
   * Where this engine keeps its configuration, what each file is called and what
   * goes in it. The whole engine-specific knowledge lives here: the service asks
   * the layout to write a bot's configuration and to read it back, and never
   * keeps a second copy of what the engine itself stores.
   */
  layout: BotEngineLayout;
}

/** Everything a host can observe from the bot layer, for its own fan-out. */
export type BotEvent =
  | { type: 'roster' }
  | { type: 'transcript'; conversationId: string; entries: BotTranscriptEntry[]; replace: boolean }
  | { type: 'routing'; state: BotRoutingState | null };

/** The roster the sidebar draws: every bot, every conversation. */
export interface BotRoster {
  bots: BotSummary[];
  conversations: BotConversationSummary[];
}

export interface BotServiceOptions {
  /** `<dataDir>/bot`: one directory per bot plus the registry. */
  root: string;
  /** Host-provided integrations, keyed by engine kind (Task 6 wires them). */
  adapters: Record<string, BotEngineAdapter>;
  /** The host's workspace; a bot still gets its own `workspace/` as cwd. */
  defaultWorkspace: WorkspaceRef;
  logger: MorseLogger;
  /** How long a gateway stays warm after its last event. Default 5 minutes. */
  idleMs?: number;
  /** How long one bot turn (or one gateway start) may take. Default 5 minutes. */
  turnTimeoutMs?: number;
  /** Bot-to-bot relays allowed per human message. Default 8. */
  defaultChainCap?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * The slice of `BotService` the host's controller delegates to. Narrower than the
 * service on purpose: transport code cannot accidentally subscribe or dispose.
 */
export type BotControllerPort = Pick<
  BotService,
  | 'roster'
  | 'createBot'
  | 'deleteBot'
  | 'inspectBot'
  | 'updateBot'
  | 'createGroup'
  | 'probeModels'
  | 'discoverModels'
  | 'open'
  | 'history'
  | 'send'
  | 'stop'
  | 'newDiscussion'
>;

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_CHAIN_CAP = 8;

/** The refusal a second concurrent send gets, in the transcript and the promise. */
const ROUND_IN_FLIGHT = 'A round is already running in this conversation.';

/** A run is in flight: the answer it is waiting on and what it has said so far. */
interface PromptOutcome {
  reply: string;
  reason: 'settled' | 'aborted' | 'error';
  error?: string;
  /** True when the reason is already recorded as its own transcript note. */
  noted?: boolean;
}

/** One live engine session, keyed by (conversation, bot). */
interface WarmGateway {
  readonly conversationId: string;
  /** The bot's username: the identity a gateway is keyed by. */
  readonly username: string;
  readonly gateway: AgentGateway;
  /** True until this session's first prompt goes out: only that one carries the persona. */
  fresh: boolean;
  detach: () => void;
  timer: NodeJS.Timeout | undefined;
  /** Resolves the prompt in flight, when one is. Set by `promptAndWait`. */
  settle: ((outcome: PromptOutcome) => void) | undefined;
  /** Assistant text seen since the current prompt started. */
  reply: string;
}

/** Who the round asks next, and how far down the chain they are. */
interface QueuedTarget {
  /** The target's username: the identity a queue entry and its gateway use. */
  username: string;
  /** Bot-to-bot deliveries taken to reach this target; the user's own message is 0. */
  hop: number;
  /** True when the target was chosen because the group crowned it lead. */
  lead: boolean;
}

interface Round {
  readonly conversation: ConversationRecord;
  stopped: boolean;
  queue: QueuedTarget[];
  /** The gateway answering right now, so `stop` can abort it. */
  current: WarmGateway | undefined;
  /** Relays delivered in this round: the user's line first, then each reply. */
  relays: string[];
  /** How many relays each bot has seen, so a re-prompted bot gets only the new ones. */
  seen: Map<string, number>;
  /** True once a routing state went out, so a silent round emits none. */
  announced: boolean;
}

export class BotService {
  private readonly registry: BotRegistryFile;
  /** Per-bot engine factories, so a bot's own engine server is started once. */
  private readonly factories = new Map<string, BotGatewayFactory>();
  /** Live gateways, keyed by conversation and bot. */
  private readonly warm = new Map<string, WarmGateway>();
  /** Transcripts live on disk, so a restart keeps every conversation's history. */
  private readonly transcripts: BotTranscriptStore;
  private readonly rounds = new Map<string, Round>();
  private readonly listeners = new Set<(event: BotEvent) => void>();
  private readonly idleMs: number;
  private readonly turnTimeoutMs: number;
  private readonly chainCap: number;
  private readonly clock: () => number;

  constructor(private readonly options: BotServiceOptions) {
    // Reading the registry is tolerant by design (an older file is migrated as
    // it loads), but the shape-changing work belongs to the data migrations the
    // host runs before this service exists — see `bot/data.ts`.
    this.registry = loadBotRegistry(options.root);
    this.transcripts = new BotTranscriptStore(options.root);
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.chainCap = options.defaultChainCap ?? DEFAULT_CHAIN_CAP;
    this.clock = options.now ?? Date.now;
  }

  /** True once the bot has a live gateway in any conversation. */
  roster(): BotRoster {
    return {
      bots: this.registry.bots.map((bot) => {
        // The engine's own files are what the roster reports, so what the reader
        // sees here is what the engine will actually run on.
        const state = this.engineState(bot);
        return {
          username: bot.username,
          name: bot.name,
          description: bot.description,
          ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
          engineKind: bot.engineKind,
          ...(state.model === undefined ? {} : { model: state.model }),
          ...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
          warm: this.isWarm(bot.username),
        };
      }),
      conversations: this.registry.conversations.map((conversation) =>
        this.summarize(conversation),
      ),
    };
  }

  subscribe(listener: (event: BotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Creates one isolated bot: its directories, portable identity, credentials,
   * engine-native subagents, optional workspace instructions, then a live probe
   * of the engine it will run on. The registry is written last, so a failed probe
   * leaves neither a bot directory nor a roster entry behind.
   */
  async createBot(input: BotCreateInput): Promise<void> {
    const adapter = this.options.adapters[input.engineKind];
    if (adapter === undefined) {
      throw new Error(`The host has no bot engine "${input.engineKind}".`);
    }
    if (!isSafeUsername(input.username)) {
      throw new Error(
        `"${input.username}" is not a usable username: use lowercase letters, digits, dashes and underscores, and start with a letter or digit.`,
      );
    }
    if (input.name.trim() === '') {
      throw new Error('A bot needs a name.');
    }
    const existing = this.registry.bots.find((candidate) => candidate.username === input.username);
    if (existing !== undefined) {
      throw new Error(
        `The username "${existing.username}" is taken: usernames name a bot's directory and its @mention, so they are unique.`,
      );
    }
    // Morse's record is an index entry, not a second configuration: identity and
    // which engine runs it. Everything a reader can change lives in the engine's
    // own files, written below.
    const record: BotRecord = {
      username: input.username,
      name: input.name.trim(),
      description: input.description,
      ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
      engineKind: input.engineKind,
      credentialEnv: [...input.envVars],
    };
    const botRoot = this.botRoot(record.username);
    let factory: BotGatewayFactory | undefined;
    try {
      mkdirSync(join(botRoot, 'config'), { recursive: true, mode: 0o700 });
      mkdirSync(join(botRoot, 'sessions'), { recursive: true, mode: 0o700 });
      mkdirSync(join(botRoot, 'workspace'), { recursive: true, mode: 0o700 });
      factory = adapter.createFactory(botRoot, this.engineEnv(record.credentialEnv));
      writeBotIdentity(botRoot, record);
      // The wizard validates these names, the wire does not — it checks message
      // types, not payloads — so this is the boundary that keeps every name usable
      // as a config key in whichever engine ends up storing it.
      for (const subagent of input.subagents ?? []) {
        if (!isSafeSubagentName(subagent.name)) {
          throw new Error(
            `"${subagent.name}" is not a usable subagent name: start with a letter, digit or underscore, and use only letters, digits, dashes and underscores.`,
          );
        }
      }
      this.writeEngineConfig(botRoot, adapter, input, input.credentials);
      // The probe runs as the bot itself — its root, its credentials — so a bad
      // key fails here instead of on the reader's first message.
      await this.readModels(factory, this.workspaceOf(record.username));
    } catch (error) {
      // A half-built bot must not survive: the retry after fixing the key would
      // otherwise look like a duplicate, and a dead directory would sit in the
      // data dir forever. The factory goes first, so an engine server the probe
      // started is stopped before its tree is removed.
      await this.disposeFactory(
        factory,
        'Failed to dispose a bot factory whose create failed',
      );
      rmSync(botRoot, { recursive: true, force: true });
      throw error;
    }

    this.factories.set(record.username, factory);
    this.registry.bots.push(record);
    this.upsertDm(record);
    saveBotRegistry(this.options.root, this.registry);
    this.emit({ type: 'roster' });
  }

  /**
   * Removes a bot and everything of its own on disk. Conversations stay — their
   * ids are the reader's history, and renumbering them would break every open
   * tab — so a deleted bot's DM simply has no bot to answer it anymore.
   */
  async deleteBot(username: string): Promise<void> {
    const bot = this.botOrThrow(username);
    const gateways = [...this.warm.values()].filter((warm) => warm.username === bot.username);
    await Promise.all(gateways.map((warm) => this.dropWarm(warm, true)));
    const factory = this.factories.get(bot.username);
    this.factories.delete(bot.username);
    await this.disposeFactory(factory, "Failed to dispose a deleted bot's factory");
    this.transcripts.forget(dmConversationId(bot.username));
    rmSync(this.botRoot(bot.username), { recursive: true, force: true });
    this.registry.bots = this.registry.bots.filter(
      (candidate) => candidate.username !== bot.username,
    );
    saveBotRegistry(this.options.root, this.registry);
    this.emit({ type: 'roster' });
  }

  /**
   * Hands the bot's whole configuration to its engine's layout, which writes the
   * files that engine reads. Morse keeps no copy of what lands there.
   */
  private writeEngineConfig(
    botRoot: string,
    adapter: BotEngineAdapter,
    input: BotCreateInput | BotUpdateInput,
    credentials: { provider: string; apiKey: string }[],
  ): void {
    const config: BotEngineConfig = {
      username: 'username' in input ? input.username : '',
      name: input.name.trim(),
      description: input.description,
      persona: input.persona,
      ...(input.agentsMd === undefined ? {} : { agentsMd: input.agentsMd }),
      credentials,
      providers: 'providers' in input ? (input.providers ?? []) : [],
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.subagents === undefined ? {} : { subagents: input.subagents }),
    };
    adapter.layout.write(botRoot, config);
  }

  /**
   * What Edit bot shows: Morse's index entry, plus everything read back out of
   * the engine's own configuration files. Credentials are the exception — they
   * are secrets in the engine's store, and a form that shows them back would be
   * a form that leaks them; a blank field keeps what is there.
   */
  inspectBot(username: string): BotConfig {
    const bot = this.botOrThrow(username);
    const state = this.engineState(bot);
    return {
      username: bot.username,
      name: bot.name,
      description: bot.description,
      ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
      engineKind: bot.engineKind,
      ...(state.model === undefined ? {} : { model: state.model }),
      ...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
      persona: state.persona ?? '',
      envVars: [...bot.credentialEnv],
      ...(state.tools === undefined ? {} : { tools: state.tools }),
      ...(state.agentsMd === undefined ? {} : { agentsMd: state.agentsMd }),
      ...(state.subagents === undefined ? {} : { subagents: state.subagents }),
    };
  }

  /**
   * The editable parts of a bot as its engine holds them. A layout that cannot
   * answer (a tree being created, a hand-broken file) yields nothing rather than
   * failing a roster push: the row still lists, with what Morse knows.
   */
  private engineState(bot: BotRecord): BotEngineState {
    const adapter = this.options.adapters[bot.engineKind];
    if (adapter === undefined) {
      return {};
    }
    try {
      return adapter.layout.read(this.botRoot(bot.username));
    } catch (error: unknown) {
      this.options.logger.warn('Failed to read a bot engine configuration', error);
      return {};
    }
  }

  /**
   * Saves an edit to one bot: its record, its workspace instructions and the
   * subagents its engine stores. The name and the engine are fixed — a bot's
   * directory is named after it, and its engine owns the config already in that
   * tree — so this rewrites what the reader can change instead of rebuilding.
   */
  async updateBot(input: BotUpdateInput): Promise<void> {
    const bot = this.botOrThrow(input.username);
    if (this.roundFor(bot.username) !== undefined) {
      throw new Error(`Bot "${bot.name}" is answering: edit it once the turn ends.`);
    }
    if (input.name.trim() === '') {
      throw new Error('A bot needs a name.');
    }
    const adapter = this.options.adapters[bot.engineKind];
    if (adapter === undefined) {
      throw new Error(`The host has no bot engine "${bot.engineKind}".`);
    }
    // Subagent names become config keys in the engine's own file, so the same
    // boundary create enforces applies here.
    for (const subagent of input.subagents ?? []) {
      if (!isSafeSubagentName(subagent.name)) {
        throw new Error(
          `"${subagent.name}" is not a usable subagent name: start with a letter, digit or underscore, and use only letters, digits, dashes and underscores.`,
        );
      }
    }
    const updated: BotRecord = {
      username: bot.username,
      name: input.name.trim(),
      description: input.description,
      ...(input.avatar === undefined || input.avatar.trim().length === 0
        ? {}
        : { avatar: input.avatar }),
      engineKind: bot.engineKind,
      credentialEnv: [...input.envVars],
    };
    const botRoot = this.botRoot(bot.username);
    writeBotIdentity(botRoot, updated);
    // The engine's own files carry the rest, rewritten from the form. Keys are
    // taken from the form when it collected any, and from the engine's own store
    // otherwise (`currentCredentials`) — a blank field means "keep what is
    // there", not "delete my keys".
    // No key collected in the form means "keep the engine's own": the layout
    // leaves its credential store untouched for an empty list.
    this.writeEngineConfig(botRoot, adapter, input, input.credentials ?? []);
    this.registry.bots = this.registry.bots.map((candidate) =>
      candidate.username === bot.username ? updated : candidate,
    );
    // A stored engine session would resume the old persona, model and env, and a
    // live gateway still holds them; both go, so the next message opens a session
    // with what was just saved — and the persona is delivered again, because that
    // rides on a fresh session's first prompt.
    for (const conversation of this.registry.conversations) {
      if (conversation.sessions[bot.username] !== undefined) {
        delete conversation.sessions[bot.username];
        this.touched(conversation);
      }
    }
    saveBotRegistry(this.options.root, this.registry);
    const gateways = [...this.warm.values()].filter((warm) => warm.username === bot.username);
    await Promise.all(gateways.map((warm) => this.dropWarm(warm, true)));
    const factory = this.factories.get(bot.username);
    if (factory !== undefined) {
      this.factories.delete(bot.username);
      await this.disposeFactory(factory, "Failed to dispose an edited bot's factory");
    }
    this.emit({ type: 'roster' });
  }

  createGroup(input: BotGroupCreateInput): BotConversationSummary {
    if (input.name.trim() === '') {
      throw new Error('A group needs a name.');
    }
    if (input.members.length === 0) {
      throw new Error('A group needs at least one member.');
    }
    for (const member of input.members) {
      this.botOrThrow(member);
    }
    if (input.lead !== undefined && !input.members.includes(input.lead)) {
      throw new Error(`The lead "${input.lead}" is not a member of the group.`);
    }
    const id = newGroupId(input.name);
    const chainCap = input.chainCap ?? this.chainCap;
    const group: GroupRecord = {
      id,
      name: input.name,
      members: [...input.members],
      ...(input.lead === undefined ? {} : { lead: input.lead }),
      chainCap,
    };
    const conversation: ConversationRecord = {
      id,
      kind: 'group',
      title: input.name,
      members: [...input.members],
      ...(input.lead === undefined ? {} : { lead: input.lead }),
      chainCap,
      sessions: {},
      updatedAt: this.clock(),
    };
    this.registry.groups.push(group);
    this.registry.conversations.push(conversation);
    saveBotRegistry(this.options.root, this.registry);
    this.emit({ type: 'roster' });
    return this.summarize(conversation);
  }

  /**
   * The engine's model catalog, read from a throwaway root that is removed again.
   * The wizard probes before any bot exists, so nothing here may depend on one;
   * the declared environment variables are the ones the wizard chose to expose,
   * and the credentials are the ones it collected — written into the same
   * throwaway tree, because an engine cannot list models for a key it cannot see.
   */
  /**
   * Asks an OpenAI-compatible endpoint what models it serves, with the wizard's
   * credential. Engine-agnostic by definition: listing is the provider API's
   * job, and the answer becomes whatever the engine's config format wants.
   */
  async discoverModels(
    baseUrl: string,
    credential: BotProviderCredentialInput,
  ): Promise<BotProviderModel[]> {
    return await discoverOpenAiCompatibleModels(baseUrl, credential);
  }

  async probeModels(
    kind: string,
    envVars: string[],
    credentials: { provider: string; apiKey: string }[],
  ): Promise<ModelRef[]> {
    const adapter = this.options.adapters[kind];
    if (adapter === undefined) {
      throw new Error(`The host has no bot engine "${kind}".`);
    }
    const probeRoot = join(this.options.root, `.probe-${randomBytes(4).toString('hex')}`);
    const workspace: WorkspaceRef = {
      cwd: join(probeRoot, 'workspace'),
      // The probe asks about an engine, not about a bot that does not exist yet,
      // so it borrows the host's display name for the temporary workspace.
      name: this.options.defaultWorkspace.name,
    };
    mkdirSync(workspace.cwd, { recursive: true, mode: 0o700 });
    let factory: BotGatewayFactory | undefined;
    try {
      // Credentials first: the probe gateway reads them from the root it runs
      // in, so the layout writes them the way this engine expects.
      adapter.layout.write(probeRoot, {
        username: `.probe`,
        name: 'probe',
        description: '',
        persona: '',
        credentials,
        providers: [],
      });
      factory = adapter.createFactory(probeRoot, this.engineEnv(envVars));
      return await this.readModels(factory, workspace);
    } finally {
      await this.disposeFactory(factory, 'Failed to dispose a bot probe factory');
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }

  /** The whole conversation, oldest first. A read: an unknown id is simply empty. */
  transcript(conversationId: string): BotTranscriptEntry[] {
    return this.transcripts.all(conversationId);
  }

  /**
   * The newest page, which is what opening a conversation shows. `hasMore` tells
   * the chat whether scrolling up has anything to fetch.
   */
  open(conversationId: string, limit: number = TRANSCRIPT_PAGE_SIZE): TranscriptPage {
    return this.transcripts.latest(conversationId, limit);
  }

  /** The page before `beforeId`, for the chat's scroll-to-top. */
  history(
    conversationId: string,
    beforeId: string | undefined,
    limit: number = TRANSCRIPT_PAGE_SIZE,
  ): TranscriptPage {
    return this.transcripts.before(conversationId, beforeId, limit);
  }

  /**
   * Sends one human message and runs the whole round it starts — every mention,
   * every chained relay — before the returned promise settles.
   *
   * Deliberately not `async`: a second send while a round is in flight must reject
   * before the caller's next await, so two clicks cannot fork one conversation
   * into two interleaved rounds.
   */
  send(conversationId: string, text: string): Promise<void> {
    const conversation = this.registry.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    if (conversation === undefined) {
      // Always a rejected promise, never a synchronous throw: the host's request
      // handler awaits this call and reports the error the same way either way.
      return Promise.reject(new Error(`No bot conversation "${conversationId}".`));
    }
    if (this.rounds.has(conversationId)) {
      // The host can only surface this as a transcript line, and the transcript is
      // ours, so the note is appended here before the promise rejects.
      this.note(conversationId, ROUND_IN_FLIGHT);
      return Promise.reject(new Error(ROUND_IN_FLIGHT));
    }
    return this.runConversationRound(conversation, text);
  }

  /** Aborts the answer in flight and drops every relay queued behind it. */
  stop(conversationId: string): void {
    const round = this.rounds.get(conversationId);
    if (round === undefined) {
      return;
    }
    round.stopped = true;
    round.queue.length = 0;
    this.note(conversationId, 'Stopped.');
    const warm = round.current;
    if (warm !== undefined) {
      void this.abortTurn(warm);
    }
  }

  /**
   * Tries the engine's own abort, then settles the turn either way. An abort that
   * fails, or one the engine acknowledges without ever sending `run-end`, must
   * still release the round — otherwise the conversation refuses every later send.
   */
  private async abortTurn(warm: WarmGateway): Promise<void> {
    try {
      await warm.gateway.abort();
    } catch (error: unknown) {
      this.options.logger.warn('Failed to abort a bot turn', error);
    } finally {
      warm.settle?.({ reply: warm.reply, reason: 'aborted' });
    }
  }

  /**
   * Forgets where each participant's engine session was, so the next message
   * opens new ones. The engines' own session files stay on disk; only this
   * conversation's pointer to them is cleared.
   */
  newDiscussion(conversationId: string): void {
    const conversation = this.conversationOrThrow(conversationId);
    const round = this.rounds.get(conversationId);
    if (round !== undefined) {
      // The reader is leaving this discussion: no relay queued for the old
      // sessions may still be delivered, and the turn in flight is abandoned
      // with them. The force-drop below settles it; aborting it first would
      // target a gateway that is already being disposed.
      round.stopped = true;
      round.queue.length = 0;
    }
    // The boundary is a line in the same transcript, so one chat reads as the
    // sequence of engine sessions it is — and it survives a restart with them.
    const divider = this.transcripts.appendDivider(conversationId, this.clock());
    this.emit({ type: 'transcript', conversationId, entries: [divider], replace: false });
    for (const member of conversation.members) {
      const warm = this.warm.get(warmKey(conversationId, member));
      if (warm !== undefined) {
        // A kept process would answer the next message in the discussion the
        // reader just left, so it goes before the stored ids do.
        void this.dropWarm(warm, true);
      }
    }
    conversation.sessions = {};
    saveBotRegistry(this.options.root, this.registry);
  }

  /** Disposes every warm gateway and timer. Transcripts and listeners go too. */
  async dispose(): Promise<void> {
    for (const round of this.rounds.values()) {
      round.stopped = true;
      round.queue.length = 0;
    }
    const gateways = [...this.warm.values()];
    this.warm.clear();
    for (const warm of gateways) {
      if (warm.timer !== undefined) {
        clearTimeout(warm.timer);
        warm.timer = undefined;
      }
      warm.detach();
      // A round still waiting on this gateway would hang otherwise; it checks the
      // stopped flag next and unwinds.
      warm.settle?.({ reply: warm.reply, reason: 'aborted' });
    }
    await Promise.all(
      gateways.map(async (warm) => {
        try {
          await warm.gateway.dispose();
        } catch (error: unknown) {
          this.options.logger.warn('Failed to dispose a bot gateway', error);
        }
      }),
    );
    // Gateways first: a factory cannot stop the server a gateway still talks to.
    const factories = [...this.factories.values()];
    this.factories.clear();
    await Promise.all(
      factories.map((factory) =>
        this.disposeFactory(factory, 'Failed to dispose a bot factory on shutdown'),
      ),
    );
    this.rounds.clear();
    this.listeners.clear();
  }

  /** One human message: record it, resolve whom it addresses, run the round. */
  private async runConversationRound(
    conversation: ConversationRecord,
    text: string,
  ): Promise<void> {
    const round: Round = {
      conversation,
      stopped: false,
      queue: this.resolveTargets(conversation, text),
      current: undefined,
      relays: [relayLine(conversation.title, 'You', text)],
      seen: new Map(),
      announced: false,
    };
    this.rounds.set(conversation.id, round);
    this.append(conversation.id, { role: 'user' }, text);
    this.touched(conversation);
    try {
      while (!round.stopped && round.queue.length > 0) {
        const target = round.queue.shift() as QueuedTarget;
        round.announced = true;
        this.emit({
          type: 'routing',
          state: {
            conversationId: conversation.id,
            target: this.displayNameOf(target.username),
            queued: round.queue.map((queued) => this.displayNameOf(queued.username)),
          },
        });
        const reply = await this.answer(round, target);
        if (reply === undefined || round.stopped) {
          continue;
        }
        round.relays.push(relayLine(conversation.title, this.displayNameOf(target.username), reply));
        round.seen.set(target.username, round.relays.length);
        this.queueChains(round, target, reply);
      }
    } finally {
      if (this.rounds.get(conversation.id) === round) {
        this.rounds.delete(conversation.id);
      }
      if (round.announced) {
        this.emit({ type: 'routing', state: null });
      }
    }
  }

  /**
   * Prompts one target with the relays it has not seen yet and records its reply.
   * The persona rides on a fresh session's first prompt (the engines have no
   * system-prompt slot through Morse's ports); a lead chosen by fallback gets the
   * routing brief so it knows to answer or delegate.
   */
  private async answer(round: Round, target: QueuedTarget): Promise<string | undefined> {
    if (round.stopped) {
      return undefined;
    }
    const conversation = round.conversation;
    const bot = this.bot(target.username);
    if (bot === undefined) {
      this.note(
        conversation.id,
        `No bot with the username "${target.username}" is left in this conversation.`,
      );
      return undefined;
    }
    const unseen = round.relays.slice(round.seen.get(bot.username) ?? 0);
    round.seen.set(bot.username, round.relays.length);
    const broadcast =
      target.lead && conversation.kind === 'group'
        ? `${leadBrief(conversation.title)}\n\n${unseen.join('\n\n')}`
        : unseen.join('\n\n');

    let warm: WarmGateway;
    try {
      warm = await this.ensureGateway(bot, conversation);
    } catch (error) {
      this.note(conversation.id, `${bot.name} could not start: ${errorMessage(error)}`);
      return undefined;
    }
    if (round.stopped) {
      return undefined;
    }
    round.current = warm;
    try {
      // No prompt prefix: the persona is the engine's own instruction file (pi's
      // agent-dir AGENTS.md, OpenCode's `instructions`), written once by the
      // layout, so the engine applies it exactly as it would for a hand-built
      // agent. Morse sends only what the reader typed.
      const outcome = await this.promptAndWait(warm, broadcast);
      if (round.stopped) {
        return undefined;
      }
      const reply = outcome.reply.trim();
      if (reply !== '') {
        this.append(conversation.id, botAuthor(bot), reply);
        return reply;
      }
      if (outcome.reason === 'error' && outcome.noted !== true) {
        this.note(
          conversation.id,
          `${bot.name} failed${outcome.error === undefined ? '' : `: ${outcome.error}`}`,
        );
      }
      return undefined;
    } catch (error) {
      this.note(conversation.id, `${bot.name} failed: ${errorMessage(error)}`);
      return undefined;
    } finally {
      round.current = undefined;
    }
  }

  /**
   * Queues the teammates a reply addresses. Every bot-to-bot delivery costs one
   * hop; past the conversation's cap the relay is dropped with a visible note
   * rather than silently swallowed.
   */
  private queueChains(round: Round, from: QueuedTarget, reply: string): void {
    const conversation = round.conversation;
    const byHandle = new Map(conversation.members.map((name) => [name.toLowerCase(), name]));
    const queued = new Set<string>();
    const reported = new Set<string>();
    const enqueue = (username: string): void => {
      if (username === from.username || queued.has(username)) {
        return;
      }
      queued.add(username);
      const hop = from.hop + 1;
      if (hop > conversation.chainCap) {
        this.note(conversation.id, `Chain capped after ${conversation.chainCap} hops`);
        return;
      }
      round.queue.push({ username, hop, lead: false });
    };

    for (const token of mentionTokens(reply)) {
      const handle = token.toLowerCase();
      if (handle === 'all' || handle === 'everyone') {
        for (const member of conversation.members) {
          enqueue(member);
        }
        continue;
      }
      const member = byHandle.get(handle);
      if (member === undefined) {
        if (!reported.has(handle)) {
          reported.add(handle);
          this.note(
            conversation.id,
            `Ignored mention of @${token}: not a member of this conversation.`,
          );
        }
        continue;
      }
      if (member === from.username) {
        if (!reported.has(handle)) {
          reported.add(handle);
          this.note(
            conversation.id,
            `Ignored mention of @${member}: a bot does not relay to itself.`,
          );
        }
        continue;
      }
      enqueue(member);
    }
  }

  /** Whom one human message addresses, in the order they answer. */
  private resolveTargets(conversation: ConversationRecord, text: string): QueuedTarget[] {
    const { targets, all } = parseMentions(text, conversation.members);
    const addressed = (username: string): QueuedTarget => ({ username, hop: 0, lead: false });
    if (targets.length > 0) {
      return targets.map(addressed);
    }
    if (all) {
      return conversation.members.map(addressed);
    }
    // A DM has exactly one participant: its whole point is that no address is
    // needed. A group without a lead is mentions-only by design.
    if (conversation.kind === 'dm') {
      return conversation.members.map(addressed);
    }
    if (conversation.lead !== undefined) {
      return [{ username: conversation.lead, hop: 0, lead: true }];
    }
    return [];
  }

  /**
   * The live gateway for (conversation, bot), created from a stored engine
   * session id when there is one and recorded when the engine names its new
   * session. Model and thinking level are applied on every creation, the same
   * runtime path code mode uses.
   */
  private async ensureGateway(
    bot: BotRecord,
    conversation: ConversationRecord,
  ): Promise<WarmGateway> {
    const key = warmKey(conversation.id, bot.username);
    const existing = this.warm.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const adapter = this.options.adapters[bot.engineKind];
    if (adapter === undefined) {
      throw new Error(`The host has no bot engine "${bot.engineKind}".`);
    }
    const factory = this.factoryFor(bot, adapter);
    const stored = conversation.sessions[bot.username]?.engineSessionId;
    const creating = factory.create({
      workspace: this.workspaceOf(bot.username),
      ...(stored === undefined ? {} : { sessionId: stored }),
    });
    let gateway: AgentGateway;
    try {
      gateway = await this.withDeadline(creating, 'gateway creation');
    } catch (error) {
      // A create that only finishes after the deadline would leak a process
      // nobody holds a reference to; dispose it when it eventually lands.
      void creating.then((late) => late.dispose()).catch(() => undefined);
      throw error;
    }
    let sessionId: string | undefined;
    try {
      const state = await this.withDeadline(gateway.state(), 'gateway startup');
      sessionId = state.sessionId;
      // Model and thinking level are best-effort: engines declare per-model
      // capabilities, and a stored choice the current model does not offer must
      // not keep the bot from answering. The engine's default stands instead.
      // The engine's own config is where the choice lives; read it once per
      // gateway start so a hand-edited opencode.json or settings.json applies.
      const stored = this.engineState(bot);
      if (stored.model !== undefined) {
        const model = stored.model;
        await this.applyStartupSetting(
          () => this.withDeadline(gateway.setModel(model), 'gateway startup'),
          conversation.id,
          `Model "${model.provider}/${model.id}" is not available on this engine — using the engine default.`,
        );
      }
      if (stored.thinkingLevel !== undefined) {
        const level = stored.thinkingLevel;
        await this.applyStartupSetting(
          () => this.withDeadline(gateway.setThinkingLevel(level), 'gateway startup'),
          conversation.id,
          `Thinking level "${level}" is not available on this model — using the engine default.`,
        );
      }
    } catch (error) {
      await gateway.dispose().catch((disposalError: unknown) => {
        this.options.logger.warn(
          'Failed to dispose a bot gateway that would not start',
          disposalError,
        );
      });
      throw error;
    }

    const warm: WarmGateway = {
      conversationId: conversation.id,
      username: bot.username,
      gateway,
      fresh: stored === undefined,
      detach: () => undefined,
      timer: undefined,
      settle: undefined,
      reply: '',
    };
    warm.detach = gateway.subscribe((event) => {
      this.onGatewayEvent(warm, event);
    });
    this.warm.set(key, warm);
    if (sessionId !== undefined) {
      conversation.sessions[bot.username] = { engineSessionId: sessionId };
      this.touched(conversation);
    }
    this.touch(warm);
    this.emit({ type: 'roster' });
    return warm;
  }

  /** Prompts one gateway and resolves on its run-end, with the last thing it said. */
  private async promptAndWait(warm: WarmGateway, text: string): Promise<PromptOutcome> {
    warm.reply = '';
    let deadline: NodeJS.Timeout | undefined;
    const settled = new Promise<PromptOutcome>((resolve) => {
      // A turn the engine never ends must not hold the round — and with it the
      // whole conversation — forever. The deadline settles it and forces the
      // silent gateway out (see `expireTurn`).
      deadline = setTimeout(() => {
        this.expireTurn(warm);
      }, this.turnTimeoutMs);
      deadline.unref?.();
      warm.settle = (outcome) => {
        if (deadline !== undefined) {
          clearTimeout(deadline);
        }
        warm.settle = undefined;
        resolve(outcome);
      };
    });
    this.touch(warm);
    let disposition: PromptDisposition;
    try {
      disposition = await warm.gateway.prompt(text, 'new');
    } catch (error) {
      // A prompt the engine refused leaves nothing to wait for; clearing the slot
      // keeps the gateway evictable instead of looking busy forever.
      warm.settle = undefined;
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      throw error;
    }
    if (disposition === 'handled') {
      // A command the engine answered itself: no run will end, so the round does
      // not wait for one.
      warm.settle?.({ reply: warm.reply, reason: 'settled' });
    }
    return settled;
  }

  /**
   * The turn deadline fired: record it, settle the round as a failed turn, and
   * dispose the gateway so a silent engine cannot keep a process (or the round)
   * alive. The settle slot is only cleared by `promptAndWait`'s own wrapper, so a
   * timer that lost the race to a real run-end does nothing.
   */
  private expireTurn(warm: WarmGateway): void {
    const settle = warm.settle;
    if (settle === undefined) {
      return;
    }
    this.note(warm.conversationId, `Turn timed out after ${this.turnTimeoutMs / 1000}s`);
    settle({ reply: warm.reply, reason: 'error', noted: true });
    void this.dropWarm(warm, true);
  }

  /**
   * Applies a stored runtime choice, but never refuses the session over it: an
   * engine that does not offer this model or level throws
   * `UnsupportedByHostError`, which is a capability answer, not a failure to
   * start. It is logged and said in the transcript, and the bot runs on the
   * engine's default. Any other error still fails the startup.
   */
  private async applyStartupSetting(
    work: () => Promise<void>,
    conversationId: string,
    note: string,
  ): Promise<void> {
    try {
      await work();
    } catch (error: unknown) {
      if (!(error instanceof UnsupportedByHostError)) {
        throw error;
      }
      this.options.logger.warn(note, error);
      this.note(conversationId, note);
    }
  }

  /**
   * Waits for engine work no longer than one turn's budget. An adapter that never
   * answers a `create`/`state` call must not hold a round open either.
   */
  private async withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${this.turnTimeoutMs / 1000}s`));
          }, this.turnTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Everything a gateway reports: idle bookkeeping, replies, prompts, completion. */
  private onGatewayEvent(warm: WarmGateway, event: AgentEvent): void {
    this.touch(warm);
    switch (event.type) {
      case 'agent/message':
        // The last assistant message before run-end is the turn's reply;
        // intermediate prose between tool calls is not relayed.
        warm.reply = event.text;
        break;
      case 'agent/interaction':
        void this.autoAnswer(warm, event.request);
        break;
      case 'agent/run-end': {
        const settle = warm.settle;
        if (settle !== undefined) {
          settle({
            reply: warm.reply,
            reason: event.reason,
            ...(event.error === undefined ? {} : { error: event.error }),
          });
        }
        break;
      }
      case 'agent/fatal': {
        // A dead engine will never send run-end; waiting would hang the round.
        const settle = warm.settle;
        if (settle !== undefined) {
          settle({ reply: warm.reply, reason: 'error', error: event.message });
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Answers an engine's question on the bot's behalf — a bot conversation has no
   * reader to ask — and says how in the transcript so nothing is hidden.
   */
  private async autoAnswer(warm: WarmGateway, request: AgentInteractionRequest): Promise<void> {
    this.note(warm.conversationId, `Auto-answered: ${autoAnswerSummary(request)}`);
    try {
      await warm.gateway.respondToInteraction(autoAnswerFor(request));
    } catch (error: unknown) {
      this.options.logger.warn('Failed to auto-answer a bot interaction', error);
    }
  }

  /**
   * (Re)starts a gateway's idle timer. Every event pushes it back, so a long turn
   * never looks idle; expiry disposes the process and forgets it, and the next
   * message resumes from the stored session id.
   */
  private touch(warm: WarmGateway): void {
    if (warm.timer !== undefined) {
      clearTimeout(warm.timer);
    }
    warm.timer = setTimeout(() => {
      void this.dropWarm(warm);
    }, this.idleMs);
    warm.timer.unref?.();
  }

  /** Drops one gateway, resolving any prompt it was still answering. */
  private async dropWarm(warm: WarmGateway, force = false): Promise<void> {
    const key = warmKey(warm.conversationId, warm.username);
    if (this.warm.get(key) !== warm) {
      return;
    }
    // An idle timer must not retire a turn in flight, however quiet it looks —
    // but an explicit drop (a deleted bot, a new discussion) must not be refused
    // by one either.
    if (!force && warm.settle !== undefined) {
      this.touch(warm);
      return;
    }
    this.warm.delete(key);
    if (warm.timer !== undefined) {
      clearTimeout(warm.timer);
      warm.timer = undefined;
    }
    warm.detach();
    // A round waiting on this gateway would hang; tell it the turn is over before
    // the process goes away.
    warm.settle?.({ reply: warm.reply, reason: 'aborted' });
    this.emit({ type: 'roster' });
    try {
      await warm.gateway.dispose();
    } catch (error: unknown) {
      this.options.logger.warn('Failed to dispose an idle bot gateway', error);
    }
  }

  private append(conversationId: string, author: BotAuthor, text: string): BotTranscriptEntry {
    const entry = this.transcripts.append(conversationId, {
      id: randomUUID(),
      author,
      text,
      at: this.clock(),
    });
    this.emit({ type: 'transcript', conversationId, entries: [entry], replace: false });
    return entry;
  }

  /** A routing note: Morse speaking, not a bot. */
  private note(conversationId: string, text: string): void {
    this.append(conversationId, { role: 'system' }, text);
  }

  private emit(event: BotEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.options.logger.error('Bot event listener failed', error);
      }
    }
  }

  private summarize(conversation: ConversationRecord): BotConversationSummary {
    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      members: [...conversation.members],
      ...(conversation.lead === undefined ? {} : { lead: conversation.lead }),
      chainCap: conversation.chainCap,
      updatedAt: conversation.updatedAt,
    };
  }

  /** Every mutation of a conversation's place in the roster rewrites the registry. */
  private touched(conversation: ConversationRecord): void {
    conversation.updatedAt = this.clock();
    saveBotRegistry(this.options.root, this.registry);
  }

  /** Creates the DM conversation for a bot, or repairs a kept one after a recreate. */
  private upsertDm(bot: BotRecord): void {
    const id = dmConversationId(bot.username);
    const existing = this.registry.conversations.find((conversation) => conversation.id === id);
    if (existing !== undefined) {
      // The title follows the display name, which an edit can change.
      existing.title = bot.name;
      existing.members = [bot.username];
      delete existing.lead;
      existing.chainCap = this.chainCap;
      // A recreated bot starts fresh: the old engine sessions belonged to the
      // deleted bot's directory.
      existing.sessions = {};
      existing.updatedAt = this.clock();
      return;
    }
    this.registry.conversations.push({
      id,
      kind: 'dm',
      title: bot.name,
      members: [bot.username],
      chainCap: this.chainCap,
      sessions: {},
      updatedAt: this.clock(),
    });
  }

  /**
   * The environment an engine factory gets.
   *
   * The host environment is spread whole, not narrowed to the bot's declared
   * variables: a child process needs PATH, HOME and the platform's own variables
   * to start at all (the integrations' env builders document the same hazard),
   * and what a bot may *use* is confined by the integration pointing its config
   * and session directories at the bot's root. The declared names are copied
   * explicitly so a future host that scopes its base cannot silently drop them.
   */
  private engineEnv(envVars: readonly string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of envVars) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    return env;
  }

  /** One factory per bot, created on demand and reused for every session it opens. */
  private factoryFor(bot: BotRecord, adapter: BotEngineAdapter): BotGatewayFactory {
    const factory = this.factories.get(bot.username);
    if (factory !== undefined) {
      return factory;
    }
    const created = adapter.createFactory(
      this.botRoot(bot.username),
      this.engineEnv(bot.credentialEnv),
    );
    this.factories.set(bot.username, created);
    return created;
  }

  /** Reads a gateway's model catalog and always disposes it. */
  private async readModels(
    factory: AgentGatewayFactory,
    workspace: WorkspaceRef,
  ): Promise<ModelRef[]> {
    const gateway =
      factory.probeDefaults !== undefined
        ? await factory.probeDefaults({ workspace })
        : await factory.create({ workspace });
    try {
      const state = await gateway.state();
      return state.availableModels;
    } finally {
      await gateway.dispose().catch((error: unknown) => {
        this.options.logger.warn('Failed to dispose a bot probe gateway', error);
      });
    }
  }

  /**
   * Disposes a factory when it has a teardown, logging rather than throwing: a
   * disposed engine server or a failed probe must not turn into a second error
   * on the way out. A factory without `dispose` is simply left to the engine.
   */
  private async disposeFactory(
    factory: BotGatewayFactory | undefined,
    failure: string,
  ): Promise<void> {
    if (factory === undefined) {
      return;
    }
    try {
      await factory.dispose?.();
    } catch (error: unknown) {
      this.options.logger.warn(failure, error);
    }
  }

  private isWarm(username: string): boolean {
    for (const warm of this.warm.values()) {
      if (warm.username === username) {
        return true;
      }
    }
    return false;
  }

  private bot(username: string): BotRecord | undefined {
    return this.registry.bots.find((candidate) => candidate.username === username);
  }

  private botOrThrow(username: string): BotRecord {
    const bot = this.bot(username);
    if (bot === undefined) {
      throw new Error(`No bot with the username "${username}".`);
    }
    return bot;
  }

  /** The display name for a username, for a line a reader reads. */
  private displayNameOf(username: string): string {
    return this.bot(username)?.name ?? username;
  }

  /** The round this bot is answering in right now, if any. */
  private roundFor(username: string): Round | undefined {
    for (const round of this.rounds.values()) {
      if (round.conversation.members.includes(username)) {
        return round;
      }
    }
    return undefined;
  }

  private conversationOrThrow(conversationId: string): ConversationRecord {
    const conversation = this.registry.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    if (conversation === undefined) {
      throw new Error(`No bot conversation "${conversationId}".`);
    }
    return conversation;
  }

  private botRoot(username: string): string {
    return join(this.options.root, username);
  }

  private workspaceOf(username: string): WorkspaceRef {
    return { cwd: join(this.botRoot(username), 'workspace'), name: username };
  }
}

/** The transcript line a relay arrives as: who, in which conversation, said what. */
function relayLine(title: string, author: string, text: string): string {
  return `[${title}] ${author}: ${text}`;
}

/** The brief an unaddressed group message prefixes onto its lead's prompt. */
function leadBrief(title: string): string {
  return `You are the lead of the group "${title}". Answer or @mention the teammate who should answer.`;
}

/** The default answer to one engine question. */
function autoAnswerFor(request: AgentInteractionRequest): AgentInteractionResponse {
  switch (request.kind) {
    case 'confirm':
      return { requestId: request.requestId, confirmed: true };
    case 'select':
      return { requestId: request.requestId, value: request.options[0]?.value ?? '' };
    case 'input':
      return { requestId: request.requestId, value: request.value ?? '' };
    case 'editor':
      // The engine's own draft is the answer. A bot has no reader to type one,
      // and cancelling loses the whole tool call — a web search opened as an
      // editor prompt never runs when the prompt is dismissed instead.
      return { requestId: request.requestId, value: request.value ?? '' };
    case 'form':
      return { requestId: request.requestId, values: formDefaults(request) };
  }
}

/**
 * A form's answer, filled the way a silent reader would: the seed a field
 * carries, the first choice a list offers, and the empty value its type implies.
 * Nothing is invented beyond that — a bot cannot reason about a form it cannot
 * see, so the safest complete answer is its own defaults.
 */
function formDefaults(request: AgentFormRequest): Record<string, AgentFormValue> {
  const values: Record<string, AgentFormValue> = {};
  for (const field of request.fields) {
    if (field.defaultValue !== undefined) {
      values[field.key] = field.defaultValue;
      continue;
    }
    switch (field.type) {
      case 'boolean':
        values[field.key] = false;
        break;
      case 'number':
      case 'integer':
        values[field.key] = 0;
        break;
      case 'multiselect':
        values[field.key] = [];
        break;
      case 'select': {
        const first = field.options?.[0]?.value;
        if (first !== undefined) {
          values[field.key] = first;
        }
        break;
      }
      default:
        values[field.key] = '';
    }
  }
  return values;
}

/** How the transcript describes an auto-answer, stable per request kind. */
function autoAnswerSummary(request: AgentInteractionRequest): string {
  switch (request.kind) {
    case 'confirm':
      return `confirmed "${request.title}"`;
    case 'select':
      return `selected the first option of "${request.title}"`;
    case 'input':
    case 'editor':
      return request.value === undefined || request.value.length === 0
        ? `left "${request.title}" blank`
        : `filled "${request.title}" from its draft`;
    case 'form':
      return `filled "${request.title}" with its defaults`;
  }
}

function botAuthor(bot: BotRecord): BotAuthor {
  return {
    role: 'bot',
    name: bot.name,
    username: bot.username,
    ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
  };
}

/**
 * A username that stays inside `<root>/<username>/` and parses as a `@handle`:
 * lowercase letters, digits, dashes and underscores, starting with a letter or
 * digit, at most 32 characters. Keeping it lowercase is what makes a mention
 * unambiguous, and keeping it slash-free is what keeps it a directory name that
 * cannot escape the data dir.
 */
function isSafeUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(username);
}

/** A subagent name that is usable as a config key in either engine's own file. */
function isSafeSubagentName(name: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(name);
}

function warmKey(conversationId: string, username: string): string {
  return `${conversationId}\u0000${username}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
