import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentEvent,
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
  BotConversationSummary,
  BotCreateInput,
  BotGroupCreateInput,
  BotRoutingState,
  BotSummary,
  BotTranscriptEntry,
} from '@morse/protocol';
import type { MorseLogger } from '../logger.js';
import { mentionTokens, parseMentions } from './mentions.js';
import {
  dmConversationId,
  loadBotRegistry,
  newGroupId,
  saveBotRegistry,
  writeBotIdentity,
} from './store.js';
import type {
  BotEngineCapabilities,
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

export interface BotEngineAdapter {
  /** Stable engine kind, the value `BotRecord.engineKind` carries. */
  kind: string;
  capabilities: BotEngineCapabilities;
  /**
   * A factory confined to one bot's directory. Built once per bot and cached:
   * an integration may start a long-lived engine server in here, so a second
   * call would start a second server for the same bot.
   */
  createFactory(botRoot: string, env: NodeJS.ProcessEnv): AgentGatewayFactory;
  /** Replaces the bot's whole engine-native credential store. */
  writeCredentials(botRoot: string, entries: { provider: string; apiKey: string }[]): void;
  /**
   * Stores the bot's named subagents in the engine's own config. Optional: an
   * engine without named subagents leaves it off, and `capabilities` says so
   * too — the service checks both, because a claim is not a method.
   */
  writeSubagents?(botRoot: string, subagents: { name: string; prompt: string }[]): void;
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
  | 'createGroup'
  | 'probeModels'
  | 'open'
  | 'send'
  | 'stop'
  | 'newDiscussion'
>;

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_CHAIN_CAP = 8;

/** The refusal a second concurrent send gets, in the transcript and the promise. */
const ROUND_IN_FLIGHT = 'A round is already running in this conversation.';

/** Says the reader left the conversation's engine sessions behind. */
const NEW_DISCUSSION_NOTE = 'New discussion started.';

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
  readonly botName: string;
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
  name: string;
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
  private readonly factories = new Map<string, AgentGatewayFactory>();
  /** Live gateways, keyed by conversation and bot. */
  private readonly warm = new Map<string, WarmGateway>();
  /** Transcripts are in memory only: a restart starts a fresh transcript (MVP). */
  private readonly transcripts = new Map<string, BotTranscriptEntry[]>();
  private readonly rounds = new Map<string, Round>();
  private readonly listeners = new Set<(event: BotEvent) => void>();
  private readonly idleMs: number;
  private readonly turnTimeoutMs: number;
  private readonly chainCap: number;
  private readonly clock: () => number;

  constructor(private readonly options: BotServiceOptions) {
    this.registry = loadBotRegistry(options.root);
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.chainCap = options.defaultChainCap ?? DEFAULT_CHAIN_CAP;
    this.clock = options.now ?? Date.now;
  }

  /** True once the bot has a live gateway in any conversation. */
  roster(): BotRoster {
    return {
      bots: this.registry.bots.map((bot) => ({
        name: bot.name,
        description: bot.description,
        ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
        engineKind: bot.engineKind,
        ...(bot.model === undefined ? {} : { model: bot.model }),
        ...(bot.thinkingLevel === undefined ? {} : { thinkingLevel: bot.thinkingLevel }),
        warm: this.isWarm(bot.name),
      })),
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
    if (!isSafeBotName(input.name)) {
      throw new Error(
        `"${input.name}" is not a usable bot name: start with a letter, digit or underscore, and use only letters, digits, dashes and underscores.`,
      );
    }
    const existing = this.registry.bots.find(
      (candidate) => candidate.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (existing !== undefined) {
      throw new Error(
        `A bot named "${existing.name}" already exists: bot names are case-insensitive because they are @mentions.`,
      );
    }
    const record: BotRecord = {
      name: input.name,
      description: input.description,
      ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
      engineKind: input.engineKind,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      persona: input.persona,
      credentialEnv: [...input.envVars],
      ...(input.subagents === undefined || input.subagents.length === 0
        ? {}
        : { subagents: input.subagents.map((subagent) => ({ ...subagent })) }),
    };
    const botRoot = this.botRoot(record.name);
    let factory: AgentGatewayFactory;
    try {
      mkdirSync(join(botRoot, 'config'), { recursive: true });
      mkdirSync(join(botRoot, 'sessions'), { recursive: true });
      mkdirSync(join(botRoot, 'workspace'), { recursive: true });
      factory = adapter.createFactory(botRoot, this.engineEnv(record.credentialEnv));
      writeBotIdentity(botRoot, record);
      // The adapter replaces the whole credential store: the wizard's list is
      // the complete answer for this bot, never a merge with an older one.
      adapter.writeCredentials(botRoot, input.credentials);
      // The wizard validates these names, the wire does not — it checks message
      // types, not payloads — so this is the boundary that keeps every stored
      // name usable as a config key, whichever engine ends up storing it.
      for (const subagent of input.subagents ?? []) {
        if (!isSafeBotName(subagent.name)) {
          throw new Error(
            `"${subagent.name}" is not a usable subagent name: start with a letter, digit or underscore, and use only letters, digits, dashes and underscores.`,
          );
        }
      }
      // Subagents are engine config, so only an engine that has them is asked to
      // store them; a pi bot is created with just the record's copy.
      if (
        input.subagents !== undefined &&
        input.subagents.length > 0 &&
        adapter.writeSubagents !== undefined &&
        adapter.capabilities.supportsSubagents
      ) {
        adapter.writeSubagents(botRoot, input.subagents);
      }
      if (input.agentsMd !== undefined) {
        writeFileSync(join(botRoot, 'workspace', 'AGENTS.md'), input.agentsMd);
      }
      // The probe runs as the bot itself — its root, its credentials — so a bad
      // key fails here instead of on the reader's first message.
      await this.readModels(factory, this.workspaceOf(record.name));
    } catch (error) {
      // A half-built bot must not survive: the retry after fixing the key would
      // otherwise look like a duplicate, and a dead directory would sit in the
      // data dir forever.
      rmSync(botRoot, { recursive: true, force: true });
      throw error;
    }

    this.factories.set(record.name, factory);
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
  async deleteBot(name: string): Promise<void> {
    const bot = this.botOrThrow(name);
    const gateways = [...this.warm.values()].filter((warm) => warm.botName === bot.name);
    await Promise.all(gateways.map((warm) => this.dropWarm(warm, true)));
    this.factories.delete(bot.name);
    rmSync(this.botRoot(bot.name), { recursive: true, force: true });
    this.registry.bots = this.registry.bots.filter((candidate) => candidate.name !== bot.name);
    saveBotRegistry(this.options.root, this.registry);
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
   * the declared environment variables are the ones the wizard chose to expose.
   */
  async probeModels(kind: string, envVars: string[]): Promise<ModelRef[]> {
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
    mkdirSync(workspace.cwd, { recursive: true });
    try {
      return await this.readModels(
        adapter.createFactory(probeRoot, this.engineEnv(envVars)),
        workspace,
      );
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }

  /** The conversation's transcript. A read, so an unknown id is simply empty. */
  transcript(conversationId: string): BotTranscriptEntry[] {
    return [...(this.transcripts.get(conversationId) ?? [])];
  }

  open(conversationId: string): BotTranscriptEntry[] {
    return this.transcript(conversationId);
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
      this.note(conversationId, NEW_DISCUSSION_NOTE);
    }
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
    this.rounds.clear();
    this.transcripts.clear();
    this.factories.clear();
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
            target: target.name,
            queued: round.queue.map((queued) => queued.name),
          },
        });
        const reply = await this.answer(round, target);
        if (reply === undefined || round.stopped) {
          continue;
        }
        round.relays.push(relayLine(conversation.title, target.name, reply));
        round.seen.set(target.name, round.relays.length);
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
    const bot = this.bot(target.name);
    if (bot === undefined) {
      this.note(conversation.id, `No bot named "${target.name}" is left in this conversation.`);
      return undefined;
    }
    const unseen = round.relays.slice(round.seen.get(bot.name) ?? 0);
    round.seen.set(bot.name, round.relays.length);
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
    // The persona is delivered once, engine-agnostically, on the first prompt of
    // a session Morse opened from scratch. A resumed session already carries it.
    const persona = warm.fresh && bot.persona.trim() !== '' ? `${bot.persona}\n\n---\n\n` : '';

    round.current = warm;
    try {
      const outcome = await this.promptAndWait(warm, `${persona}${broadcast}`);
      // The session now exists in the engine's eyes either way: the persona rides
      // on its first prompt only.
      warm.fresh = false;
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
    const enqueue = (name: string): void => {
      if (name === from.name || queued.has(name)) {
        return;
      }
      queued.add(name);
      const hop = from.hop + 1;
      if (hop > conversation.chainCap) {
        this.note(conversation.id, `Chain capped after ${conversation.chainCap} hops`);
        return;
      }
      round.queue.push({ name, hop, lead: false });
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
      if (member === from.name) {
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
    const addressed = (name: string): QueuedTarget => ({ name, hop: 0, lead: false });
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
      return [{ name: conversation.lead, hop: 0, lead: true }];
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
    const key = warmKey(conversation.id, bot.name);
    const existing = this.warm.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const adapter = this.options.adapters[bot.engineKind];
    if (adapter === undefined) {
      throw new Error(`The host has no bot engine "${bot.engineKind}".`);
    }
    const factory = this.factoryFor(bot, adapter);
    const stored = conversation.sessions[bot.name]?.engineSessionId;
    const creating = factory.create({
      workspace: this.workspaceOf(bot.name),
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
      if (bot.model !== undefined) {
        await this.withDeadline(gateway.setModel(bot.model), 'gateway startup');
      }
      if (bot.thinkingLevel !== undefined) {
        await this.withDeadline(gateway.setThinkingLevel(bot.thinkingLevel), 'gateway startup');
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
      botName: bot.name,
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
      conversation.sessions[bot.name] = { engineSessionId: sessionId };
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
   * Answers an engine's question with the default a human would not have to
   * approve in MVP, and says so in the transcript so nothing is hidden.
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
    const key = warmKey(warm.conversationId, warm.botName);
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
    const entry: BotTranscriptEntry = { id: randomUUID(), author, text, at: this.clock() };
    const entries = this.transcripts.get(conversationId);
    if (entries === undefined) {
      this.transcripts.set(conversationId, [entry]);
    } else {
      entries.push(entry);
    }
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
    const id = dmConversationId(bot.name);
    const existing = this.registry.conversations.find((conversation) => conversation.id === id);
    if (existing !== undefined) {
      existing.title = bot.name;
      existing.members = [bot.name];
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
      members: [bot.name],
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
  private factoryFor(bot: BotRecord, adapter: BotEngineAdapter): AgentGatewayFactory {
    const factory = this.factories.get(bot.name);
    if (factory !== undefined) {
      return factory;
    }
    const created = adapter.createFactory(
      this.botRoot(bot.name),
      this.engineEnv(bot.credentialEnv),
    );
    this.factories.set(bot.name, created);
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

  private isWarm(botName: string): boolean {
    for (const warm of this.warm.values()) {
      if (warm.botName === botName) {
        return true;
      }
    }
    return false;
  }

  private bot(name: string): BotRecord | undefined {
    return this.registry.bots.find((candidate) => candidate.name === name);
  }

  private botOrThrow(name: string): BotRecord {
    const bot = this.bot(name);
    if (bot === undefined) {
      throw new Error(`No bot named "${name}".`);
    }
    return bot;
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

  private botRoot(name: string): string {
    return join(this.options.root, name);
  }

  private workspaceOf(name: string): WorkspaceRef {
    return { cwd: join(this.botRoot(name), 'workspace'), name };
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
      return { requestId: request.requestId, value: '' };
    default:
      // Editor and form answers cannot be guessed safely, so they are cancelled —
      // deliberately not the same as submitting empty values.
      return { requestId: request.requestId, cancelled: true };
  }
}

/** How the transcript describes an auto-answer, stable per request kind. */
function autoAnswerSummary(request: AgentInteractionRequest): string {
  switch (request.kind) {
    case 'confirm':
      return `confirmed "${request.title}"`;
    case 'select':
      return `selected the first option of "${request.title}"`;
    case 'input':
      return `left "${request.title}" blank`;
    default:
      return `cancelled "${request.title}"`;
  }
}

function botAuthor(bot: BotRecord): BotAuthor {
  return {
    role: 'bot',
    name: bot.name,
    ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
  };
}

/** A bot name that stays inside `<root>/<name>/`, and is also a usable `@handle`. */
function isSafeBotName(name: string): boolean {
  // The name is the bot's mention handle, so it must parse as one: no spaces, no
  // dots, and a leading character that keeps it clear of the `.probe-*` roots.
  return /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(name);
}

function warmKey(conversationId: string, botName: string): string {
  return `${conversationId}\u0000${botName}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
