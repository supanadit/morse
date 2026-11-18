import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  AgentEvent,
  AgentGateway,
  AgentGatewayFactory,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentSessionState,
  AgentUserMessage,
  ModelRef,
  PromptDisposition,
  ThinkingLevel,
  WorkspaceRef,
} from '@morse/agent';
import type { BotCreateInput, BotDelivery, BotMcpServerInput, BotRoutingState, PromptImage } from '@morse/protocol';
import { BOT_DESCRIPTION_LIMIT } from '@morse/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../logger.js';
import { UnsupportedByHostError } from '../errors.js';
import { BUS_LIMITS } from './bus.js';
import { DELIVERY_TTL_MS } from './deliveries.js';
import type { BotEngineAdapter, BotEvent } from './service.js';
import type { BotEngineConfig, BotEngineLayout, BotEngineState, BotMcpServer } from './types.js';
import { BotBusError, BotService } from './service.js';
import { loadBotRegistry, readBotIdentity, saveBotRegistry } from './store.js';
import type { BotEngineCapabilities, BotRecord } from './types.js';

/**
 * BotService is the bot layer's whole behaviour: it owns the registry, opens an
 * isolated engine gateway per (conversation, bot), relays one round at a time and
 * bounds bot-to-bot chatter. The fakes below stand in for the engine integrations
 * — the service must never name one, so nothing here does either.
 */

const MODEL: ModelRef = {
  provider: 'anthropic',
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4',
  contextWindow: 200_000,
};

/** One scripted turn: what the fake agent says and asks before it settles. */
interface FakeTurn {
  text?: string;
  /** Work the fake reports before it answers, so activity can be observed. */
  tools?: { name: string; title?: string; input?: string }[];
  interactions?: AgentInteractionRequest[];
  /** Keep the run open until `release()` or `abort()`, so a test can act mid-round. */
  hold?: boolean;
  /** Resolve `abort()` without ever emitting `run-end`, like a wedged engine. */
  abortSilently?: boolean;
}

type Script = (context: { bot: string; prompt: string; call: number }) => FakeTurn;

interface FactoryOptions {
  models?: ModelRef[];
  /** False makes the factory look like an engine without `probeDefaults`. */
  probeDefaults?: boolean;
  probeThrows?: boolean;
  /** Make the first `create` call never settle, like a wedged engine spawn. */
  hangFirstCreate?: boolean;
  /** Makes the fake look like an engine that stores named subagents (OpenCode). */
  supportsSubagents?: boolean;
  /** Leaves `writeSubagents` off, so the service must not call a missing method. */
  omitSubagentWriter?: boolean;
  /** Makes the fake look like OpenCode refusing a level the current model lacks. */
  thinkingUnsupported?: boolean;
  /** Counters the fake's `state()` reports, the way a real engine reports them. */
  sessionUsage?: Partial<AgentSessionState>;
  /** Makes the fake refuse `compact()`, like an engine without one. */
  compactUnsupported?: boolean;
  script: Script;
}

/** One gateway a fake factory handed out, with everything a test can observe. */
class FakeGateway implements AgentGateway {
  readonly kind = 'fake';
  readonly prompts: string[] = [];
  /** The images each prompt carried, in the same order as `prompts`. */
  readonly imagesSent: (PromptImage[] | undefined)[] = [];
  readonly responses: AgentInteractionResponse[] = [];
  readonly modelsApplied: ModelRef[] = [];
  readonly levelsApplied: ThinkingLevel[] = [];
  /** How many times the engine was asked to summarise its own context. */
  compacted = 0;
  disposed = false;
  aborted = false;
  /** Resolves the first time a prompt is sent, so a test can act mid-round. */
  readonly prompted: Promise<void>;
  private markPrompted!: () => void;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly waiting = new Map<string, () => void>();
  private releaseHold: (() => void) | undefined;
  private silentAbort = false;

  constructor(
    private readonly factory: FakeFactory,
    private readonly sessionId: string,
  ) {
    this.prompted = new Promise((resolve) => {
      this.markPrompted = resolve;
    });
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  state(): Promise<AgentSessionState> {
    return Promise.resolve({
      sessionId: this.sessionId,
      workspace: this.factory.workspace,
      thinkingLevel: 'off',
      availableModels: this.factory.models,
      availableThinkingLevels: ['off', 'low', 'high'],
      availableCommands: [],
      streaming: false,
      ...this.factory.sessionUsage,
    });
  }

  history(): Promise<{ entries: never[]; hasOlder: boolean }> {
    return Promise.resolve({ entries: [], hasOlder: false });
  }

  prompt(text: string, _mode?: unknown, images?: PromptImage[]): Promise<PromptDisposition> {
    this.prompts.push(text);
    this.imagesSent.push(images);
    this.markPrompted();
    const turn = this.factory.script({
      bot: this.factory.botName,
      prompt: text,
      call: this.prompts.length,
    });
    // A fresh turn is not the aborted one before it.
    this.aborted = false;
    this.silentAbort = turn.abortSilently === true;
    this.emit({ type: 'agent/run-start', at: 0 });
    void this.run(turn);
    return Promise.resolve('started');
  }

  userMessages(): Promise<AgentUserMessage[]> {
    return Promise.resolve([]);
  }

  rewrite(): Promise<{ text: string; cancelled: boolean }> {
    return Promise.resolve({ text: '', cancelled: true });
  }

  clone(): Promise<{ cancelled: boolean }> {
    return Promise.resolve({ cancelled: true });
  }

  fork(): Promise<{ text: string; cancelled: boolean }> {
    return Promise.resolve({ text: '', cancelled: true });
  }

  abort(): Promise<void> {
    this.aborted = true;
    this.releaseHold?.();
    this.releaseHold = undefined;
    if (!this.silentAbort) {
      this.emit({ type: 'agent/run-end', at: 0, reason: 'aborted' });
    }
    return Promise.resolve();
  }

  setModel(model: ModelRef): Promise<void> {
    this.modelsApplied.push(model);
    return Promise.resolve();
  }

  setThinkingLevel(level: ThinkingLevel): Promise<void> {
    if (this.factory.thinkingUnsupported) {
      return Promise.reject(
        new UnsupportedByHostError(`This model does not offer the "${level}" thinking level.`),
      );
    }
    this.levelsApplied.push(level);
    return Promise.resolve();
  }

  compact(): Promise<void> {
    this.compacted += 1;
    if (this.factory.compactUnsupported) {
      return Promise.reject(new UnsupportedByHostError('this engine cannot compact a session'));
    }
    return Promise.resolve();
  }

  respondToInteraction(response: AgentInteractionResponse): Promise<void> {
    this.responses.push(response);
    const release = this.waiting.get(response.requestId);
    this.waiting.delete(response.requestId);
    release?.();
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.releaseHold?.();
    this.releaseHold = undefined;
    for (const release of this.waiting.values()) {
      release();
    }
    this.waiting.clear();
    this.listeners.clear();
    return Promise.resolve();
  }

  /** Ends a held turn as if the agent had finished on its own. */
  release(): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private async run(turn: FakeTurn): Promise<void> {
    for (const request of turn.interactions ?? []) {
      await this.waitForAnswer(request);
    }
    if (turn.hold === true) {
      await new Promise<void>((resolve) => {
        this.releaseHold = resolve;
      });
      this.releaseHold = undefined;
    }
    if (this.aborted) {
      return;
    }
    let call = 0;
    for (const tool of turn.tools ?? []) {
      call += 1;
      const toolCallId = `call-${call}`;
      this.emit({
        type: 'agent/tool-start',
        at: 0,
        toolCallId,
        name: tool.name,
        title: tool.title ?? tool.name,
        ...(tool.input === undefined ? {} : { input: tool.input }),
      });
      this.emit({ type: 'agent/tool-end', at: 0, toolCallId, status: 'ok' });
    }
    this.emit({ type: 'agent/message', at: 0, text: turn.text ?? '', thinking: '' });
    this.emit({ type: 'agent/run-end', at: 0, reason: 'settled' });
  }

  private waitForAnswer(request: AgentInteractionRequest): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiting.set(request.requestId, resolve);
      this.emit({ type: 'agent/interaction', at: 0, request });
    });
  }
}

class FakeFactory implements AgentGatewayFactory {
  readonly createCalls: { workspace: WorkspaceRef; sessionId?: string }[] = [];
  /** Gateways opened for a conversation, in creation order. */
  readonly gateways: FakeGateway[] = [];
  /** Gateways opened only to probe a catalog; separate so tests stay unambiguous. */
  readonly probed: FakeGateway[] = [];
  probeCalls = 0;
  /** How many times the service tore this factory down. */
  disposes = 0;
  /** Engine session ids the service asked this factory to delete. */
  readonly removedSessions: string[] = [];
  /** Set to make an engine that cannot delete a session, like a read-only store. */
  failRemoveSession = false;
  /** Whether the wizard's credentials were on disk when the factory was built. */
  readonly credentialsPresent: boolean;
  probeDefaults?: (options: { workspace: WorkspaceRef }) => Promise<AgentGateway>;
  private next = 0;

  constructor(
    readonly botRoot: string,
    readonly script: Script,
    readonly models: ModelRef[],
    private readonly options: FactoryOptions,
  ) {
    this.credentialsPresent = existsSync(join(botRoot, 'config', 'credentials.json'));
    if (options.probeDefaults !== false) {
      this.probeDefaults = (input) => this.probe(input.workspace);
    }
  }

  get botName(): string {
    return basename(this.botRoot);
  }

  get thinkingUnsupported(): boolean {
    return this.options.thinkingUnsupported === true;
  }

  get compactUnsupported(): boolean {
    return this.options.compactUnsupported === true;
  }

  get sessionUsage(): Partial<AgentSessionState> {
    return this.options.sessionUsage ?? {};
  }

  get workspace(): WorkspaceRef {
    return { cwd: join(this.botRoot, 'workspace'), name: this.botName };
  }

  /** An engine server's teardown; the service must call it wherever it is done. */
  dispose(): Promise<void> {
    this.disposes += 1;
    return Promise.resolve();
  }

  /** Deleting one stored engine session, the way a group delete will ask. */
  removeSession(sessionId: string): Promise<void> {
    if (this.failRemoveSession) {
      return Promise.reject(new Error('engine offline'));
    }
    this.removedSessions.push(sessionId);
    return Promise.resolve();
  }

  create(input: { workspace: WorkspaceRef; sessionId?: string }): Promise<AgentGateway> {
    this.createCalls.push(input);
    if (this.options.hangFirstCreate === true && this.createCalls.length === 1) {
      // A spawn that never answers: only the service's deadline can end it.
      return new Promise<AgentGateway>(() => undefined);
    }
    this.next += 1;
    const gateway = new FakeGateway(
      this,
      input.sessionId ?? `${this.botName}-session-${this.next}`,
    );
    this.gateways.push(gateway);
    return Promise.resolve(gateway);
  }

  private probe(_workspace: WorkspaceRef): Promise<AgentGateway> {
    this.probeCalls += 1;
    if (this.options.probeThrows === true) {
      return Promise.reject(new Error('probe failed'));
    }
    const gateway = new FakeGateway(this, `${this.botName}-probe-${this.probeCalls}`);
    this.probed.push(gateway);
    return Promise.resolve(gateway);
  }
}

/**
 * A fake engine layout: it records what the service asked an engine to write and
 * hands the same state back on read, which is what a real layout does with real
 * files. `capabilities.supportsSubagents` is honoured here, the way a pi layout
 * drops the list instead of writing it.
 */
class FakeLayout implements BotEngineLayout {
  readonly writes: { botRoot: string; config: BotEngineConfig }[] = [];
  readonly credentialWrites: {
    botRoot: string;
    entries: { provider: string; apiKey: string }[];
  }[] = [];
  readonly providerWrites: { botRoot: string; providers: readonly unknown[] }[] = [];
  readonly subagentWrites: {
    botRoot: string;
    subagents: { name: string; prompt: string }[];
  }[] = [];
  readonly mcpWrites: { botRoot: string; servers: readonly BotMcpServer[] }[] = [];
  /** Set to make the engine's provider writer fail, like a full disk. */
  failProviders = false;
  private readonly states = new Map<string, BotEngineState>();

  constructor(
    private readonly capabilities: BotEngineCapabilities,
    private readonly omitSubagents = false,
  ) {}

  write(botRoot: string, config: BotEngineConfig): void {
    this.writes.push({ botRoot, config });
    // An empty list means "keep the engine's own keys": the real layouts skip the
    // credential store in that case, so the record does too.
    if (config.credentials.length > 0) {
      this.credentialWrites.push({ botRoot, entries: config.credentials });
      mkdirSync(join(botRoot, 'config'), { recursive: true });
      writeFileSync(
        join(botRoot, 'config', 'credentials.json'),
        JSON.stringify(config.credentials),
      );
    }
    if (config.providers.length > 0) {
      if (this.failProviders) {
        throw new Error('disk full');
      }
      this.providerWrites.push({ botRoot, providers: config.providers });
    }
    // Subagents are engine config: an engine without them drops the list, the
    // same rule the real adapters follow, and a defined-but-empty list clears it.
    if (
      config.subagents !== undefined &&
      !this.omitSubagents &&
      this.capabilities.supportsSubagents
    ) {
      this.subagentWrites.push({ botRoot, subagents: config.subagents });
    }
    if (config.mcpServers !== undefined) {
      this.mcpWrites.push({ botRoot, servers: config.mcpServers });
    }
    this.states.set(botRoot, {
      persona: config.persona,
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
      ...(config.agentsMd === undefined ? {} : { agentsMd: config.agentsMd }),
      ...(config.subagents === undefined ? {} : { subagents: config.subagents }),
      ...(config.mcpServers === undefined ? {} : { mcpServers: [...config.mcpServers] }),
    });
  }

  read(botRoot: string): BotEngineState {
    return this.states.get(botRoot) ?? {};
  }
}

class FakeAdapter implements BotEngineAdapter {
  readonly kind = 'fake';
  readonly capabilities: BotEngineCapabilities;
  readonly factories: FakeFactory[] = [];
  readonly layout: FakeLayout;
  readonly envs: NodeJS.ProcessEnv[] = [];

  constructor(
    private readonly script: Script = () => ({}),
    private readonly options: FactoryOptions = { script },
  ) {
    this.capabilities = {
      supportsSubagents: options.supportsSubagents === true,
      supportsThinkingLevels: true,
      credentials: 'stored',
    };
    this.layout = new FakeLayout(this.capabilities, options.omitSubagentWriter === true);
  }

  get credentialWrites(): FakeLayout['credentialWrites'] {
    return this.layout.credentialWrites;
  }

  get providerWrites(): FakeLayout['providerWrites'] {
    return this.layout.providerWrites;
  }

  get subagentWrites(): FakeLayout['subagentWrites'] {
    return this.layout.subagentWrites;
  }

  /** One switch the older tests flipped: make the provider write fail. */
  set writeProviders(_: unknown) {
    this.layout.failProviders = true;
  }

  createFactory(botRoot: string, env: NodeJS.ProcessEnv): FakeFactory {
    this.envs.push(env);
    const factory = new FakeFactory(botRoot, this.script, this.options.models ?? [], this.options);
    this.factories.push(factory);
    return factory;
  }
}

function factoryFor(adapter: FakeAdapter, bot: string): FakeFactory {
  const factory = adapter.factories.find((candidate) => basename(candidate.botRoot) === bot);
  if (factory === undefined) {
    throw new Error(`The fake adapter never made a factory for ${bot}`);
  }
  return factory;
}

function gatewayFor(adapter: FakeAdapter, bot: string, index = 0): FakeGateway {
  const gateway = factoryFor(adapter, bot).gateways[index];
  if (gateway === undefined) {
    throw new Error(`${bot} has no gateway #${index}`);
  }
  return gateway;
}

/** Lets pending promise chains advance without moving the clock. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Waits until every lane with work in one conversation has run out of it.
 *
 * Lanes run in the background now — `send` resolves when the work is queued, not
 * when it is answered — so a test that reads the answer gives the lane its turn
 * first. The fakes below settle on microtasks, so draining those is enough; a
 * held turn is released by the test itself.
 */
async function settle(service: BotService, conversationId = 'dm-forge'): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (service.routing(conversationId) === null) {
      await flush();
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`The lanes in "${conversationId}" never settled.`);
}

/** The delivery rows the service persisted for one conversation. */
function deliveriesOf(root: string, conversationId: string): BotDelivery[] {
  const path = join(root, 'deliveries', `${conversationId}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as BotDelivery[]) : [];
}

/**
 * Makes the next registry save fail for real: the path `registry.json` must be is
 * a directory, so both the atomic rename and the in-place fallback refuse it.
 */
function blockRegistryWrites(root: string): void {
  rmSync(join(root, 'registry.json'));
  mkdirSync(join(root, 'registry.json'));
}

interface HarnessOptions {
  script?: Script;
  models?: ModelRef[];
  probeDefaults?: boolean;
  probeThrows?: boolean;
  hangFirstCreate?: boolean;
  idleMs?: number;
  turnTimeoutMs?: number;
  /** The clock the service reads, so a test can move a day in one step. */
  now?: () => number;
  supportsSubagents?: boolean;
  omitSubagentWriter?: boolean;
  thinkingUnsupported?: boolean;
  sessionUsage?: Partial<AgentSessionState>;
  compactUnsupported?: boolean;
  /** The host's local bot-bus URL, handed to each bot's engine. */
  busEndpoint?: string;
}

interface Harness {
  root: string;
  adapter: FakeAdapter;
  service: BotService;
}

const openHarnesses: Harness[] = [];

function serviceOn(root: string, adapter: FakeAdapter, options: HarnessOptions = {}): BotService {
  return new BotService({
    root,
    adapters: { fake: adapter },
    defaultWorkspace: { cwd: root, name: 'morse' },
    logger: silentLogger,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.busEndpoint === undefined ? {} : { busEndpoint: options.busEndpoint }),
  });
}

function harness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'morse-bot-service-'));
  const script = options.script ?? ((): FakeTurn => ({}));
  const adapterOptions: FactoryOptions = {
    script,
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.probeDefaults === undefined ? {} : { probeDefaults: options.probeDefaults }),
    ...(options.probeThrows === undefined ? {} : { probeThrows: options.probeThrows }),
    ...(options.hangFirstCreate === undefined ? {} : { hangFirstCreate: options.hangFirstCreate }),
    ...(options.supportsSubagents === undefined
      ? {}
      : { supportsSubagents: options.supportsSubagents }),
    ...(options.omitSubagentWriter === undefined
      ? {}
      : { omitSubagentWriter: options.omitSubagentWriter }),
    ...(options.thinkingUnsupported === undefined
      ? {}
      : { thinkingUnsupported: options.thinkingUnsupported }),
    ...(options.sessionUsage === undefined ? {} : { sessionUsage: options.sessionUsage }),
    ...(options.compactUnsupported === undefined
      ? {}
      : { compactUnsupported: options.compactUnsupported }),
  };
  const adapter = new FakeAdapter(script, adapterOptions);
  const service = serviceOn(root, adapter, options);
  const created: Harness = { root, adapter, service };
  openHarnesses.push(created);
  registerService(service);
  return created;
}

/** Services opened mid-test (a restart) that no harness owns but must be torn down. */
const extraServices: BotService[] = [];

function registerService(service: BotService): void {
  extraServices.push(service);
}

afterEach(async () => {
  for (const service of extraServices.splice(0)) {
    await service.dispose().catch(() => undefined);
  }
  for (const created of openHarnesses.splice(0)) {
    rmSync(created.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

/** The line a group's first prompt opens with: who is in the room, by handle. */
const room = 'Group "Launch" — members: Forge (@forge), Sable (@sable).';

function botInput(overrides: Partial<BotCreateInput> = {}): BotCreateInput {
  return {
    username: 'forge',
    name: 'Forge',
    description: 'Builds things',
    engineKind: 'fake',
    credentials: [{ provider: 'anthropic', apiKey: 'sk-ant' }],
    envVars: ['ANTHROPIC_API_KEY'],
    persona: '',
    ...overrides,
  };
}

async function twoBots(service: BotService): Promise<void> {
  await service.createBot(botInput());
  await service.createBot(
    botInput({ username: 'sable', name: 'Sable', description: 'Reviews things' }),
  );
}

describe('BotService creation', () => {
  it('createBot writes engine.json and credentials and probes', async () => {
    const { root, adapter, service } = harness({ models: [MODEL] });
    const input = botInput({
      avatar: 'anvil.png',
      model: MODEL,
      thinkingLevel: 'medium',
      persona: 'You are Forge, the builder.',
      agentsMd: '# Forge workspace\n',
    });

    await service.createBot(input);

    const botRoot = join(root, 'forge');
    for (const dir of ['config', 'sessions', 'workspace']) {
      expect(existsSync(join(botRoot, dir))).toBe(true);
      // The bot tree holds credentials and engine sessions; on POSIX it is
      // private from the moment each directory exists.
      if (process.platform !== 'win32') {
        expect(statSync(join(botRoot, dir)).mode & 0o777).toBe(0o700);
      }
    }
    // Morse's record is an index entry: identity and the engine, nothing the
    // engine itself already stores.
    const identity: BotRecord = {
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      avatar: 'anvil.png',
      engineKind: 'fake',
      credentialEnv: ['ANTHROPIC_API_KEY'],
    };
    expect(readBotIdentity(botRoot)).toEqual(identity);
    // The configuration the reader filled went to the engine's own layout, whole.
    expect(adapter.layout.writes).toHaveLength(1);
    expect(adapter.layout.writes[0]).toMatchObject({
      botRoot,
      config: {
        username: 'forge',
        name: 'Forge',
        persona: 'You are Forge, the builder.',
        agentsMd: '# Forge workspace\n',
        model: MODEL,
        thinkingLevel: 'medium',
        credentials: input.credentials,
      },
    });
    expect(adapter.credentialWrites).toEqual([{ botRoot, entries: input.credentials }]);

    const factory = factoryFor(adapter, 'forge');
    expect(factory.probeCalls).toBe(1);
    expect(factory.probed[0]?.disposed).toBe(true);
    expect(factory.gateways).toHaveLength(0);

    expect(service.roster()).toEqual({
      bots: [
        {
          username: 'forge',
          name: 'Forge',
          description: 'Builds things',
          avatar: 'anvil.png',
          engineKind: 'fake',
          model: MODEL,
          thinkingLevel: 'medium',
          warm: false,
        },
      ],
      conversations: [
        {
          id: 'dm-forge',
          kind: 'dm',
          title: 'Forge',
          members: ['forge'],
          chainCap: 8,
          updatedAt: expect.any(Number) as number,
        },
      ],
    });
  });

  it('createBot removes a half-written bot on probe failure', async () => {
    const { root, service } = harness({ probeThrows: true });

    await expect(service.createBot(botInput())).rejects.toThrow('probe failed');

    expect(existsSync(join(root, 'forge'))).toBe(false);
    expect(service.roster()).toEqual({ bots: [], conversations: [] });
  });

  it('createBot refuses a username that would escape the bot root', async () => {
    const { service } = harness();

    await expect(
      service.createBot(botInput({ username: '../escape', name: '../escape' })),
    ).rejects.toThrow('not a usable username');

    expect(service.roster().bots).toHaveLength(0);
  });

  it('createBot refuses an uppercase username', async () => {
    const { service } = harness();

    // Usernames are lowercase so a mention is unambiguous and the directory is
    // portable; an uppercase one is a typo, not a variant.
    await expect(service.createBot(botInput({ username: 'NewsFinder' }))).rejects.toThrow(
      'not a usable username',
    );

    expect(service.roster().bots).toHaveLength(0);
  });

  it('createBot refuses a username that is taken', async () => {
    const first = harness();
    await first.service.createBot(botInput({ username: 'forge', name: 'Forge' }));

    await expect(
      first.service.createBot(botInput({ username: 'forge', name: 'The Forge' })),
    ).rejects.toThrow(/username "forge" is taken/);

    expect(first.service.roster().bots.map((bot) => bot.username)).toEqual(['forge']);
    expect(existsSync(join(first.root, 'forge'))).toBe(true);
  });

  it('keeps two bots apart when their display names collide', async () => {
    const { service } = harness();

    // The namespace is usernames: two bots may share a free-text name.
    await service.createBot(botInput({ username: 'forge', name: 'News Finder' }));
    await service.createBot(botInput({ username: 'news-finder', name: 'News Finder' }));

    expect(service.roster().bots.map((bot) => bot.username)).toEqual(['forge', 'news-finder']);
    expect(service.roster().bots.map((bot) => bot.name)).toEqual(['News Finder', 'News Finder']);
  });

  it('createGroup lists the group with its members and lead, and ignores a chain cap', async () => {
    const { service, root } = harness();
    await twoBots(service);

    const group = service.createGroup({
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
      // The dialog still sends it, but a lane has no chain to cap: the value is
      // ignored rather than stored, and the summary reports the wire's constant.
      chainCap: 3,
    });

    expect(group).toEqual({
      id: expect.stringMatching(/^grp-launch-[0-9a-f]{4}$/) as string,
      kind: 'group',
      title: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
      chainCap: 8,
      updatedAt: expect.any(Number) as number,
    });
    expect(service.roster().conversations).toContainEqual(group);
    // Neither the group record nor the conversation carries a cap any more: a
    // bot's reply queues nothing by itself.
    await flush();
    expect(loadBotRegistry(root).groups[0]).toEqual({
      id: group.id,
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
    });
    expect(loadBotRegistry(root).conversations[2]).not.toHaveProperty('chainCap');
  });

  it('updateGroup rewrites the room and clears only the removed member session', async () => {
    const { service, adapter, root } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
    });
    await service.send(group.id, '@forge @sable hello');
    await settle(service, group.id);

    const before = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
    expect(before?.sessions['forge']?.engineSessionId).toBeDefined();
    const sableSession = before?.sessions['sable']?.engineSessionId;
    const forgeGateway = gatewayFor(adapter, 'forge');

    const updated = await service.updateGroup({
      id: group.id,
      name: 'Launch, revised',
      members: ['sable'],
      lead: 'sable',
    });

    expect(updated).toMatchObject({
      title: 'Launch, revised',
      members: ['sable'],
      lead: 'sable',
    });
    const after = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
    expect(after?.sessions['forge']).toBeUndefined();
    expect(after?.sessions['sable']?.engineSessionId).toBe(sableSession);
    expect(forgeGateway.disposed).toBe(true);
  });

  it('updateGroup rejects when the registry cannot be written', async () => {
    const { service, root } = harness();
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    await flush();
    blockRegistryWrites(root);

    // A rename the file never got would otherwise be reported as done and quietly
    // revert on the next restart: the failed save has to reach the caller.
    await expect(
      service.updateGroup({ id: group.id, name: 'Launch, revised', members: ['forge', 'sable'] }),
    ).rejects.toThrow(/registry\.json/);
  });

  it('starts a fresh session when a removed member is added back', async () => {
    const { service, adapter } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    await service.send(group.id, '@forge first');
    await service.updateGroup({ id: group.id, name: 'Launch', members: ['sable'] });
    await service.updateGroup({ id: group.id, name: 'Launch', members: ['sable', 'forge'] });

    await service.send(group.id, '@forge again');

    const create = factoryFor(adapter, 'forge').createCalls.at(-1);
    expect(create?.sessionId).toBeUndefined();
  });

  it('updateGroup validates its members and lead like createGroup', async () => {
    const { service } = harness();
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge'] });

    await expect(
      service.updateGroup({ id: group.id, name: '', members: ['forge'] }),
    ).rejects.toThrow('A group needs a name.');
    await expect(
      service.updateGroup({ id: group.id, name: 'Launch', members: [] }),
    ).rejects.toThrow('A group needs at least one member.');
    await expect(
      service.updateGroup({ id: group.id, name: 'Launch', members: ['forge'], lead: 'sable' }),
    ).rejects.toThrow('The lead "sable" is not a member of the group.');
  });

  it('deleteGroup removes its transcript, records and every member session', async () => {
    const { service, adapter, root } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    await service.send(group.id, '@forge @sable hello');
    await settle(service, group.id);

    const stored = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
    const forgeSession = stored?.sessions['forge']?.engineSessionId;
    const sableSession = stored?.sessions['sable']?.engineSessionId;
    const forgeGateway = gatewayFor(adapter, 'forge');
    const sableGateway = gatewayFor(adapter, 'sable');

    await service.deleteGroup(group.id);

    expect(service.roster().conversations.some((one) => one.id === group.id)).toBe(false);
    expect(service.transcript(group.id)).toEqual([]);
    expect(factoryFor(adapter, 'forge').removedSessions).toEqual([forgeSession]);
    expect(factoryFor(adapter, 'sable').removedSessions).toEqual([sableSession]);
    expect(forgeGateway.disposed).toBe(true);
    expect(sableGateway.disposed).toBe(true);
  });

  it('deleteGroup still removes the group when engine cleanup fails', async () => {
    const { service, adapter } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge'], lead: 'forge' });
    await service.send(group.id, 'hello');
    factoryFor(adapter, 'forge').failRemoveSession = true;

    await expect(service.deleteGroup(group.id)).resolves.toBeUndefined();

    expect(service.roster().conversations.some((one) => one.id === group.id)).toBe(false);
  });

  it('deleteGroup stops a round in flight', async () => {
    const { service, adapter } = harness({
      script: ({ bot }) => ({ text: `${bot} here`, hold: true }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const sending = service.send(group.id, '@forge hold on');
    await gatewayFor(adapter, 'forge').prompted;

    await service.deleteGroup(group.id);

    await expect(sending).resolves.toBeUndefined();
    expect(gatewayFor(adapter, 'forge').disposed).toBe(true);
  });
});

describe('BotService MCP servers', () => {
  const MCP: BotMcpServerInput[] = [
    {
      name: 'filesystem',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { ALLOWED_DIR: '/tmp' },
      enabled: false,
      exposure: 'deferred',
      // A hand-written description the engine file carries: Edit bot must see it
      // and a save must pass it back, or every save erases it.
      description: 'Reads the project files',
    },
    { name: 'web', type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
  ];

  it('forwards MCP servers to the layout and reads them back', async () => {
    const { root, adapter, service } = harness({ models: [MODEL] });

    await service.createBot(botInput({ mcpServers: MCP }));

    expect(adapter.layout.mcpWrites).toEqual([{ botRoot: join(root, 'forge'), servers: MCP }]);
    expect(service.inspectBot('forge').mcpServers).toEqual(MCP);
  });

  it('leaves MCP servers alone when an update does not mention them', async () => {
    const { adapter, service } = harness();
    await service.createBot(botInput({ mcpServers: MCP }));

    await service.updateBot({
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      persona: 'You are Forge.',
      envVars: [],
    });

    expect(adapter.layout.mcpWrites).toHaveLength(1);
  });

  it('refuses an unusable, reserved or duplicate MCP name', async () => {
    const { root, service } = harness();

    await expect(
      service.createBot(botInput({ mcpServers: [{ ...MCP[0]!, name: 'has space' }] })),
    ).rejects.toThrow('not a usable MCP server name');
    await expect(
      service.createBot(botInput({ mcpServers: [{ ...MCP[0]!, name: '__proto__' }] })),
    ).rejects.toThrow('reserved');
    await expect(
      service.createBot(botInput({ mcpServers: [{ ...MCP[0]!, name: 'prototype' }] })),
    ).rejects.toThrow('reserved');
    await expect(
      service.createBot(botInput({ mcpServers: [{ ...MCP[0]!, name: 'constructor' }] })),
    ).rejects.toThrow('reserved');
    await expect(
      service.createBot(botInput({ mcpServers: [MCP[0]!, { ...MCP[0]!, command: 'other' }] })),
    ).rejects.toThrow('Two MCP servers are named "filesystem"');
    expect(existsSync(join(root, 'forge'))).toBe(false);
  });

  it('refuses a server missing its command or url', async () => {
    const { root, service } = harness();
    await expect(
      service.createBot(botInput({ mcpServers: [{ name: 'fs', type: 'stdio' }] })),
    ).rejects.toThrow('needs a command');
    await expect(
      service.createBot(botInput({ mcpServers: [{ name: 'web', type: 'http' }] })),
    ).rejects.toThrow('needs a url');
    // Refused before anything was written: no half-built tree to clean up.
    expect(existsSync(join(root, 'forge'))).toBe(false);
  });

  it('refuses an incomplete MCP server on an edit before the identity is rewritten', async () => {
    const { root, service } = harness();
    await service.createBot(botInput());
    const identityPath = join(root, 'forge', 'engine.json');
    const before = readFileSync(identityPath, 'utf8');

    await expect(
      service.updateBot({
        username: 'forge',
        name: 'Renamed',
        description: 'Changed',
        persona: 'You are Forge.',
        envVars: [],
        mcpServers: [{ name: 'fs', type: 'stdio' }],
      }),
    ).rejects.toThrow('needs a command');
    await expect(
      service.updateBot({
        username: 'forge',
        name: 'Renamed',
        description: 'Changed',
        persona: 'You are Forge.',
        envVars: [],
        mcpServers: [{ name: 'web', type: 'http' }],
      }),
    ).rejects.toThrow('needs a url');

    // The edit was refused before identity/settings were touched, so the bot is
    // exactly as it was: no half-applied update the reader has to guess at.
    expect(readFileSync(identityPath, 'utf8')).toBe(before);
    expect(service.inspectBot('forge').name).toBe('Forge');
  });

  it('refuses an unknown MCP server type', async () => {
    const { service } = harness();
    await expect(
      service.createBot(botInput({ mcpServers: [{ name: 'bad', type: 'sse' as 'http' }] })),
    ).rejects.toThrow('needs a type of stdio or http');
  });
});

describe('BotService bot deletion cleanup', () => {
  it('deleteBot keeps a multi-member group without the bot', async () => {
    const { service, root } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
    });
    await service.send(group.id, '@forge @sable hello');
    await settle(service, group.id);

    await service.deleteBot('forge');

    const registry = loadBotRegistry(root);
    const kept = registry.conversations.find((one) => one.id === group.id);
    expect(kept?.members).toEqual(['sable']);
    expect(kept?.lead).toBeUndefined();
    expect(kept?.sessions['forge']).toBeUndefined();
    expect(kept?.sessions['sable']?.engineSessionId).toBeDefined();
    expect(registry.groups.find((one) => one.id === group.id)?.members).toEqual(['sable']);
    expect(registry.conversations.some((one) => one.id === 'dm-forge')).toBe(false);
    expect(service.transcript('dm-forge')).toEqual([]);
    expect(existsSync(join(root, 'forge'))).toBe(false);
  });

  it('deleteBot removes a group whose only member it was', async () => {
    const { service, root } = harness();
    await twoBots(service);
    const group = service.createGroup({ name: 'Solo', members: ['forge'] });

    await service.deleteBot('forge');

    const registry = loadBotRegistry(root);
    expect(registry.groups.some((one) => one.id === group.id)).toBe(false);
    expect(registry.conversations.some((one) => one.id === group.id)).toBe(false);
    expect(service.transcript(group.id)).toEqual([]);
  });

  it('deleteBot stops a round it is answering in a group', async () => {
    const { service, adapter } = harness({
      script: ({ bot }) => ({ text: `${bot} here`, hold: true }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const sending = service.send(group.id, '@forge hold on');
    await gatewayFor(adapter, 'forge').prompted;

    await service.deleteBot('forge');

    await expect(sending).resolves.toBeUndefined();
    expect(gatewayFor(adapter, 'forge').disposed).toBe(true);
  });
});

describe('BotService providers', () => {
  const PROVIDERS = [
    {
      id: 'acme',
      label: 'Acme',
      api: 'openai-completions' as const,
      baseUrl: 'https://llm.acme.example/v1',
      credential: { kind: 'stored' as const, apiKey: 'sk-acme' },
      models: [{ id: 'qwen3-coder', name: 'Qwen 3 Coder' }],
    },
  ];

  it('hands a provider-capable adapter the wizard records', async () => {
    const { root, adapter, service } = harness();

    await service.createBot(botInput({ providers: PROVIDERS }));

    expect(adapter.providerWrites).toEqual([
      { botRoot: join(root, 'forge'), providers: PROVIDERS },
    ]);
  });

  it('skips the writer when the wizard sent no providers', async () => {
    const { adapter, service } = harness();

    await service.createBot(botInput());
    await service.createBot(botInput({ username: 'sable', name: 'Sable', providers: [] }));

    expect(adapter.providerWrites).toEqual([]);
  });

  it('rolls the bot back when the provider writer throws', async () => {
    const { root, adapter, service } = harness();
    adapter.writeProviders = () => {
      throw new Error('disk full');
    };

    await expect(service.createBot(botInput({ providers: PROVIDERS }))).rejects.toThrow(
      'disk full',
    );
    expect(existsSync(join(root, 'forge'))).toBe(false);
    expect(service.roster().bots).toHaveLength(0);
  });
});

describe('BotService subagents', () => {
  const SUBAGENTS = [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }];

  it('hands a subagent-capable adapter the wizard rows and keeps them on the record', async () => {
    const { root, adapter, service } = harness({ supportsSubagents: true });

    await service.createBot(botInput({ subagents: SUBAGENTS, agentsMd: '# Forge workspace\n' }));

    const botRoot = join(root, 'forge');
    expect(adapter.subagentWrites).toEqual([{ botRoot, subagents: SUBAGENTS }]);
    // They are engine config: the layout gets them, and the record keeps none.
    expect(readBotIdentity(botRoot)?.subagents).toBeUndefined();
    expect(adapter.layout.writes[0]?.config.subagents).toEqual(SUBAGENTS);
  });

  it('never asks an engine without subagents to store them', async () => {
    const { adapter, service } = harness();

    await service.createBot(botInput({ subagents: SUBAGENTS }));

    expect(adapter.capabilities.supportsSubagents).toBe(false);
    expect(adapter.subagentWrites).toEqual([]);
  });

  it('never calls a writer the adapter does not have', async () => {
    // Capabilities are a claim; the method is what can actually be called.
    const { adapter, service } = harness({ supportsSubagents: true, omitSubagentWriter: true });

    await service.createBot(botInput({ subagents: SUBAGENTS }));

    expect(adapter.writeSubagents).toBeUndefined();
    expect(adapter.subagentWrites).toEqual([]);
  });

  it('writes subagents only when the wizard said something about them', async () => {
    const { adapter, service } = harness({ supportsSubagents: true });

    // Absent means "Morse was never asked": the engine's own agents stay.
    await service.createBot(botInput());
    expect(adapter.subagentWrites).toEqual([]);

    // An explicit empty list is an answer — the form cleared them — so it is
    // written, which is what removes them from the engine's config.
    await service.createBot(botInput({ username: 'sable', name: 'Sable', subagents: [] }));
    expect(adapter.subagentWrites).toHaveLength(1);
    expect(adapter.subagentWrites[0]?.subagents).toEqual([]);
  });

  it('rolls the whole bot back when a subagent name is not usable', async () => {
    const { root, adapter, service } = harness({ supportsSubagents: true });

    await expect(
      service.createBot(botInput({ subagents: [{ name: '../escape', prompt: 'Anything.' }] })),
    ).rejects.toThrow('not a usable subagent name');

    expect(existsSync(join(root, 'forge'))).toBe(false);
    expect(adapter.subagentWrites).toEqual([]);
    expect(service.roster().bots).toHaveLength(0);
  });

  it('refuses an unusable subagent name even for an engine that stores none', async () => {
    // The service is the only validator — the wire checks message types, not
    // names — so a pi bot must not keep an unvalidated name on its record just
    // because pi has nowhere to write it.
    const { root, adapter, service } = harness();

    await expect(
      service.createBot(botInput({ subagents: [{ name: 'has space', prompt: 'Anything.' }] })),
    ).rejects.toThrow('not a usable subagent name');

    expect(existsSync(join(root, 'forge'))).toBe(false);
    expect(adapter.subagentWrites).toEqual([]);
    expect(service.roster().bots).toHaveLength(0);
  });
});

describe('BotService edits', () => {
  const SUBAGENTS = [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }];

  it('inspects a bot back exactly as the wizard filled it', async () => {
    const { service } = harness({ supportsSubagents: true, models: [MODEL] });

    await service.createBot(
      botInput({
        avatar: '🔧',
        persona: 'You are Forge.',
        model: MODEL,
        thinkingLevel: 'high',
        agentsMd: '# Forge workspace\n',
        subagents: SUBAGENTS,
      }),
    );

    expect(service.inspectBot('forge')).toEqual({
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      avatar: '🔧',
      engineKind: 'fake',
      model: MODEL,
      thinkingLevel: 'high',
      persona: 'You are Forge.',
      envVars: ['ANTHROPIC_API_KEY'],
      agentsMd: '# Forge workspace\n',
      subagents: SUBAGENTS,
    });
  });

  it('never sends credentials back with an inspect', async () => {
    const { service } = harness();
    await service.createBot(botInput());

    // The keys live in the engine's own store; Morse must not claim to know them.
    expect(service.inspectBot('forge')).not.toHaveProperty('credentials');
  });

  it('refuses to inspect a bot that does not exist', async () => {
    const { service } = harness();

    expect(() => service.inspectBot('nobody')).toThrow('No bot with the username "nobody"');
  });

  it('updateBot rewrites the record, the engine config and the roster', async () => {
    const { root, adapter, service } = harness({ supportsSubagents: true });
    await service.createBot(botInput({ agentsMd: '# old\n', subagents: SUBAGENTS }));
    const events: string[] = [];
    service.subscribe((event) => events.push(event.type));

    await service.updateBot({
      username: 'forge',
      name: 'Forged again',
      description: 'Forged again',
      avatar: '🔨',
      persona: 'You are Forge, the builder.',
      model: MODEL,
      thinkingLevel: 'low',
      envVars: ['OPENAI_API_KEY'],
      agentsMd: '# new\n',
      subagents: [{ name: 'auditor', prompt: 'Check it.' }],
    });

    const botRoot = join(root, 'forge');
    // The index entry keeps identity; everything else went to the engine layout.
    expect(readBotIdentity(botRoot)).toMatchObject({
      username: 'forge',
      name: 'Forged again',
      description: 'Forged again',
      avatar: '🔨',
      engineKind: 'fake',
      credentialEnv: ['OPENAI_API_KEY'],
    });
    expect(readBotIdentity(botRoot)).not.toHaveProperty('model');
    expect(adapter.layout.writes.at(-1)?.config).toMatchObject({
      persona: 'You are Forge, the builder.',
      agentsMd: '# new\n',
      model: MODEL,
      thinkingLevel: 'low',
      subagents: [{ name: 'auditor', prompt: 'Check it.' }],
    });
    // The roster reports what the engine holds, read back from the layout.
    expect(service.roster().bots[0]).toMatchObject({
      username: 'forge',
      name: 'Forged again',
      description: 'Forged again',
      avatar: '🔨',
      model: MODEL,
      thinkingLevel: 'low',
    });
    expect(events).toContain('roster');
  });

  it('rewrites engine-side subagents, including an emptied list', async () => {
    const { root, adapter, service } = harness({ supportsSubagents: true });
    await service.createBot(botInput({ subagents: SUBAGENTS }));
    const botRoot = join(root, 'forge');

    await service.updateBot({
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      persona: '',
      envVars: [],
      subagents: [{ name: 'auditor', prompt: 'Check it.' }],
    });
    expect(adapter.subagentWrites.at(-1)).toEqual({
      botRoot,
      subagents: [{ name: 'auditor', prompt: 'Check it.' }],
    });

    // Clearing them in the form must clear them where the engine reads them too.
    await service.updateBot({
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      persona: '',
      envVars: [],
      subagents: [],
    });
    expect(adapter.subagentWrites.at(-1)).toEqual({ botRoot, subagents: [] });
    expect(readBotIdentity(botRoot)?.subagents).toBeUndefined();
  });

  it('leaves the stored credentials alone unless a key is pasted', async () => {
    const { root, adapter, service } = harness();
    await service.createBot(botInput());
    const writes = adapter.credentialWrites.length;
    const botRoot = join(root, 'forge');

    await service.updateBot({
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      persona: 'You are Forge.',
      envVars: [],
    });
    expect(adapter.credentialWrites).toHaveLength(writes);

    await service.updateBot({
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      persona: 'You are Forge.',
      envVars: [],
      credentials: [{ provider: 'openai', apiKey: 'sk-new' }],
    });
    expect(adapter.credentialWrites.at(-1)).toEqual({
      botRoot,
      entries: [{ provider: 'openai', apiKey: 'sk-new' }],
    });
  });

  it('drops the stored engine session so a saved persona takes effect', async () => {
    const { root, adapter, service } = harness({ script: () => ({ text: 'ok' }) });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await settle(service);
    expect(gatewayFor(adapter, 'forge').prompts[0]).not.toContain('You are Forge');

    await service.updateBot({
      username: 'forge',
      name: 'Forge',
      description: 'Builds things',
      persona: 'You are Forge.',
      envVars: [],
    });

    // The stored session id is what would have resumed the old engine session.
    expect(loadBotRegistry(root).conversations[0]?.sessions).toEqual({});
    await service.send('dm-forge', 'again');
    await settle(service);
    // The edited bot gets a fresh gateway (the old one went with its factory), and
    // the persona it now runs under is the one written into the engine's files.
    const gateways = adapter.factories
      .filter((candidate) => basename(candidate.botRoot) === 'forge')
      .flatMap((factory) => factory.gateways);
    expect(gateways.length).toBeGreaterThan(1);
    expect(adapter.layout.read(join(root, 'forge')).persona).toBe('You are Forge.');
    // An edit drops the session id, so the next turn starts a fresh engine session
    // — and is handed the conversation so far rather than continuing blind.
    expect(gateways.at(-1)?.prompts.at(-1)).toBe('[Forge] You: hi\n\n[Forge] You: again');
  });

  it('refuses to edit a bot that is answering', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'late', hold: true }) });
    await service.createBot(botInput());
    const round = service.send('dm-forge', 'hi');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;

    await expect(
      service.updateBot({
        username: 'forge',
        name: 'Forge',
        description: 'Builds things',
        persona: 'You are Forge.',
        envVars: [],
      }),
    ).rejects.toThrow('is answering: edit it once the turn ends.');

    gateway.release();
    await round;
  });

  it('refuses an unusable subagent name and keeps the old record', async () => {
    const { root, service } = harness({ supportsSubagents: true });
    await service.createBot(botInput({ subagents: SUBAGENTS }));

    await expect(
      service.updateBot({
        username: 'forge',
        name: 'Changed',
        description: 'Changed',
        persona: '',
        envVars: [],
        subagents: [{ name: 'has space', prompt: 'Anything.' }],
      }),
    ).rejects.toThrow('not a usable subagent name');

    expect(readBotIdentity(join(root, 'forge'))?.description).toBe('Builds things');
  });
});

describe('BotService rounds', () => {
  it('dm send queues the turn and records the reply', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'Done.' }) });
    await service.createBot(botInput());
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.send('dm-forge', 'hi');
    await settle(service);

    expect(gatewayFor(adapter, 'forge').prompts).toEqual(['[Forge] You: hi']);
    const entries = service.transcript('dm-forge');
    expect(entries).toHaveLength(2);
    // The person's own line names the host person, so a stored delivery's origin
    // and the transcript it points at agree on who asked.
    expect(entries[0]).toMatchObject({
      author: { role: 'user', personId: 'host' },
      text: 'hi',
    });
    expect(entries[1]).toMatchObject({ author: { role: 'bot', name: 'Forge' }, text: 'Done.' });
    // Opening a conversation answers with its newest page, not the whole file.
    expect(service.open('dm-forge')).toEqual({ entries, hasMore: false });
    expect(events).toContainEqual({
      type: 'transcript',
      conversationId: 'dm-forge',
      entries: [expect.objectContaining({ text: 'hi' })],
      replace: false,
    });
    expect(events).toContainEqual({
      type: 'routing',
      conversationId: 'dm-forge',
      state: {
        conversationId: 'dm-forge',
        active: [
          { target: 'Forge', activity: expect.objectContaining({ kind: 'starting' }) },
        ],
        queued: [],
      },
    });
    // The turn ends on the conversation it ran in: a clear names its room, so a
    // chat the reader is not looking at keeps the row it still has.
    expect(events.at(-1)).toEqual({
      type: 'routing',
      conversationId: 'dm-forge',
      state: null,
    });
  });

  it('shows what the bot is doing as it goes, and keeps none of it', async () => {
    const { service } = harness({
      script: () => ({
        text: 'Brief read, plan written.',
        tools: [
          { name: 'read', title: 'read: launch-brief.md' },
          { name: 'bash', title: 'bash', input: '{"command":"npm run test:fast"}' },
        ],
      }),
    });
    await service.createBot(botInput());
    const routing: BotRoutingState[] = [];
    service.subscribe((event) => {
      if (event.type === 'routing' && event.state !== null) {
        routing.push(event.state);
      }
    });

    await service.send('dm-forge', 'plan the launch');
    await settle(service);

    // One line of presence, replaced as the bot moves on: started, thinking,
    // each tool in turn (thinking between them), then gone with the answer.
    expect(routing.map((state) => state.active[0]?.activity.label)).toEqual([
      'Getting started…',
      'Wait, let me think…',
      'Reading launch-brief.md…',
      'Thinking it over…',
      'Running npm run test:fast…',
      'Thinking it over…',
    ]);
    expect(routing.every((state) => state.active.length === 1)).toBe(true);
    expect(routing.every((state) => state.active[0]?.target === 'Forge')).toBe(true);
    expect(service.routing('dm-forge')).toBeNull();
    // The trace is not history: the transcript holds the question and the answer.
    expect(service.transcript('dm-forge').map((entry) => entry.text)).toEqual([
      'plan the launch',
      'Brief read, plan written.',
    ]);
  });

  it('gives the addressed bot the images, and its workspace the files', async () => {
    const { root, adapter, service } = harness({ script: () => ({ text: 'Read it.' }) });
    await service.createBot(botInput());
    const image: PromptImage = {
      data: Buffer.from('png').toString('base64'),
      mimeType: 'image/png',
    };

    await service.send('dm-forge', 'what do you make of this?', {
      images: [image],
      files: [
        {
          name: 'cv.pdf',
          mimeType: 'application/pdf',
          data: Buffer.from('%PDF').toString('base64'),
        },
      ],
    });
    await settle(service);

    const gateway = gatewayFor(adapter, 'forge');
    // Images are prompt content, exactly as a code session sends them.
    expect(gateway.imagesSent[0]).toEqual([image]);
    // The file is named as a path in the bot's own cwd, never inlined.
    expect(gateway.prompts[0]).toContain('File from the reader: uploads/cv.pdf');
    expect(readFileSync(join(root, 'forge', 'workspace', 'uploads', 'cv.pdf'), 'utf8')).toBe(
      '%PDF',
    );
    // The reader's own line keeps what they sent, so the bubble can show it.
    expect(service.transcript('dm-forge')[0]).toMatchObject({
      author: { role: 'user' },
      text: 'what do you make of this?',
      images: [image],
      files: ['cv.pdf'],
    });
  });

  it('gives every bot the reader’s images and says what was attached', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const image: PromptImage = { data: 'aGk=', mimeType: 'image/png' };

    await service.send(group.id, '@forge @sable look at this', {
      images: [image],
      files: [{ name: 'brief.md', mimeType: 'text/markdown', data: 'aGk=' }],
    });
    await settle(service, group.id);

    const sable = gatewayFor(adapter, 'sable');
    // The relay text says what came with the message, so a bot that was not the
    // first addressee is not answering a message whose picture it was never told
    // about.
    expect(sable.prompts[0]).toContain('[attached: 1 image, 1 file]');
    // The image is part of the human message, so every delivery from it carries it.
    expect(sable.imagesSent[0]).toEqual([image]);
  });

  it('answers every member at once, each reading the line it was asked about', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    await service.send(group.id, '@all standup');
    await settle(service, group.id);

    // Two lanes, two turns: neither reads the other's answer, because each slice
    // is pinned to the person's line the delivery asks about.
    expect(gatewayFor(adapter, 'forge').prompts).toEqual([`${room}\n\n[Launch] You: @all standup`]);
    expect(gatewayFor(adapter, 'sable').prompts).toEqual([`${room}\n\n[Launch] You: @all standup`]);
    expect(
      service
        .transcript(group.id)
        .filter((entry) => entry.author.role === 'bot')
        .map((entry) => entry.author),
    ).toEqual([
      { role: 'bot', name: 'Forge', username: 'forge' },
      { role: 'bot', name: 'Sable', username: 'sable' },
    ]);
  });

  it('queues two bots in one room at the same time', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: `${bot} done`, hold: true }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    await service.send(group.id, '@forge @sable build it');
    // Both turns started before either finished: the lanes are per bot.
    await Promise.all([gatewayFor(adapter, 'forge').prompted, gatewayFor(adapter, 'sable').prompted]);
    expect(service.routing(group.id)?.active.map((one) => one.target)).toEqual([
      'Forge',
      'Sable',
    ]);

    gatewayFor(adapter, 'forge').release();
    gatewayFor(adapter, 'sable').release();
    await settle(service, group.id);
    expect(
      service.transcript(group.id).filter((entry) => entry.author.role === 'bot'),
    ).toHaveLength(2);
  });

  it('a message sent while a bot runs becomes a second delivery, not a refusal', async () => {
    const { adapter, service } = harness({
      script: ({ call }) =>
        call === 1 ? { text: 'one done', hold: true } : { text: 'two done' },
    });
    await service.createBot(botInput());

    await service.send('dm-forge', 'one');
    await gatewayFor(adapter, 'forge').prompted;
    await service.send('dm-forge', 'two');

    // The running delivery is still Forge's; the second waits behind it.
    expect(service.routing('dm-forge')).toMatchObject({
      active: [{ target: 'Forge' }],
      queued: ['Forge'],
    });
    gatewayFor(adapter, 'forge').release();
    await settle(service);

    expect(
      service.transcript('dm-forge').filter((entry) => entry.author.role === 'bot'),
    ).toHaveLength(2);
    // Both turns happened, in arrival order; the second slice starts after the
    // line the first turn was told, so nothing is repeated.
    expect(gatewayFor(adapter, 'forge').prompts).toEqual([
      '[Forge] You: one',
      '[Forge] You: two',
    ]);
  });

  it('catches a bot up on the rounds it sat out, and never repeats itself', async () => {
    const { adapter, service } = harness({
      script: ({ bot, call }) => ({ text: `${bot} reply ${call}` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    // First message: only Forge is asked.
    await service.send(group.id, '@forge first');
    await settle(service, group.id);
    // Second: only Sable. It has never been prompted, so it is handed the whole
    // discussion — including the reply that was relayed to nobody else.
    await service.send(group.id, '@sable second');
    await settle(service, group.id);
    const sable = gatewayFor(adapter, 'sable');
    expect(sable.prompts[0]).toBe(
      `${room}\n\n[Launch] You: @forge first\n\n[Launch] Forge: forge reply 1\n\n` +
        '[Launch] You: @sable second',
    );

    // Third: Forge again. It already knows what it said itself, so its own words
    // are not repeated back to it as though someone else had said them.
    await service.send(group.id, '@forge third');
    await settle(service, group.id);
    const forge = gatewayFor(adapter, 'forge');
    expect(forge.prompts[1]).toBe(
      '[Launch] You: @sable second\n\n[Launch] Sable: sable reply 1\n\n[Launch] You: @forge third',
    );
    expect(forge.prompts[1]).not.toContain('forge reply 1');
    // Nothing is sent twice: the mark advanced with every accepted prompt.
    expect(forge.prompts[1]).not.toContain('@forge first');
  });

  it('keeps a direct message and each group on their own thread of context', async () => {
    const { adapter, service } = harness({ script: ({ bot }) => ({ text: `${bot} here` }) });
    await twoBots(service);
    const launch = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const research = service.createGroup({ name: 'Research', members: ['forge'] });

    await service.send('dm-forge', 'hello in the dm');
    await settle(service);
    // A group answers when it is addressed (or has a lead), so each line names it.
    await service.send(launch.id, '@forge hello in launch');
    await settle(service, launch.id);
    await service.send(research.id, '@forge hello in research');
    await settle(service, research.id);

    // One gateway per (conversation, bot): the dm, then each group in the order
    // they were opened.
    const [dmGate, launchGate, researchGate] = factoryFor(adapter, 'forge').gateways;
    // A conversation's context is its own: the dm line never shows up in a group,
    // and a group's lines never show up in the dm.
    expect(dmGate?.prompts).toEqual(['[Forge] You: hello in the dm']);
    expect(launchGate?.prompts[0]).toContain('hello in launch');
    expect(launchGate?.prompts[0]).not.toContain('hello in the dm');
    expect(researchGate?.prompts[0]).toContain('hello in research');
    expect(researchGate?.prompts[0]).not.toContain('hello in launch');
  });

  it('gives a new discussion a fresh session with none of the history it left', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'noted' }) });
    await service.createBot(botInput());
    await service.send('dm-forge', 'old line');
    await settle(service);
    service.newDiscussion('dm-forge');
    await service.send('dm-forge', 'new line');
    await settle(service);

    // A new discussion drops the warm gateway, so the second turn is a new one.
    const after = gatewayFor(adapter, 'forge', 1);
    // The divider is the boundary: the fresh session is not re-fed what the reader
    // deliberately walked away from.
    expect(after.prompts[0]).toBe('[Forge] You: new line');
    expect(after.prompts[0]).not.toContain('old line');
  });

  it('remembers how far each bot was told, across a restart', async () => {
    const { root, adapter, service } = harness({ script: () => ({ text: 'noted' }) });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    await service.send(group.id, '@sable only this');
    await settle(service, group.id);
    await service.dispose();

    // A second host opening the same data dir continues where the first left.
    const again = serviceOn(root, adapter);
    registerService(again);
    await again.send(group.id, '@sable and now');
    await settle(again, group.id);
    // A host restart ends the gateway, so the second host built its own factory and
    // gateway — and the mark it read from disk meant the new line was added to what
    // Sable already knew, rather than the whole discussion being replayed.
    const newest = adapter.factories
      .filter((candidate) => basename(candidate.botRoot) === 'sable')
      .at(-1);
    // Only the new line: the engine session id and the mark both persisted, so the
    // resumed session is neither re-introduced nor replayed.
    expect(newest?.gateways[0]?.prompts).toEqual(['[Launch] You: @sable and now']);
  });

  it('a graceful shutdown requeues the in-flight ask instead of losing it', async () => {
    const { root, adapter, service } = harness({
      script: () => ({ text: 'late', hold: true }),
    });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await gatewayFor(adapter, 'forge').prompted;

    await service.dispose();

    // The turn was abandoned, not answered: its row is waiting for the next host,
    // and the cursor never moved past the line it did not read.
    expect(deliveriesOf(root, 'dm-forge').map((row) => row.status)).toEqual(['queued']);
    expect(loadBotRegistry(root).conversations[0]?.sessions['forge']?.toldUpTo).toBeUndefined();

    const restartedAdapter = new FakeAdapter(() => ({ text: 'answered after restart' }));
    const restarted = serviceOn(root, restartedAdapter);
    registerService(restarted);
    await settle(restarted);

    // The recovered ask still carries the line it was created for.
    expect(gatewayFor(restartedAdapter, 'forge').prompts).toEqual(['[Forge] You: hi']);
    expect(restarted.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'answered after restart',
    });
  });

  it('unaddressed group message routes to the lead', async () => {
    const { adapter, service } = harness();
    await twoBots(service);
    const group = service.createGroup({
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
    });

    await service.send(group.id, 'what next');
    await settle(service, group.id);

    expect(gatewayFor(adapter, 'forge').prompts).toEqual([
      'You are the lead of the group "Launch". Answer or @mention the teammate who should answer.\n\n' +
        `${room}\n\n[Launch] You: what next`,
    ]);
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
  });

  it('no lead means every member answers, not silence', async () => {
    const { adapter, service } = harness({ script: ({ bot }) => ({ text: `${bot} here` }) });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    await service.send(group.id, 'hello?');
    await settle(service, group.id);

    expect(gatewayFor(adapter, 'forge').prompts).toHaveLength(1);
    expect(gatewayFor(adapter, 'sable').prompts).toHaveLength(1);
    expect(
      service
        .transcript(group.id)
        .filter((entry) => entry.author.role === 'bot')
        .map((entry) => entry.author),
    ).toEqual([
      { role: 'bot', name: 'Forge', username: 'forge' },
      { role: 'bot', name: 'Sable', username: 'sable' },
    ]);
  });

  it('a bot’s reply queues nothing and writes no chain note', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: bot === 'forge' ? '@sable take over' : 'Sable here' }),
    });
    await twoBots(service);
    const group = service.createGroup({
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
    });

    await service.send(group.id, 'go');
    await settle(service, group.id);

    // The mention is text now: a bot that wants a teammate calls `bot_send`.
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
    expect(
      service
        .transcript(group.id)
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual([]);
    expect(service.routing(group.id)).toBeNull();
  });

  it('stop aborts the running turn and cancels the queue behind it', async () => {
    const { root, adapter, service } = harness({
      script: () => ({ text: 'late', hold: true }),
    });
    await service.createBot(botInput());
    await service.send('dm-forge', 'one');
    await service.send('dm-forge', 'two');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;
    expect(service.routing('dm-forge')?.queued).toEqual(['Forge']);
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    service.stop('dm-forge');
    await settle(service);

    expect(gateway.aborted).toBe(true);
    // A stop is not a teardown: the engine stays warm for the next message.
    expect(gateway.disposed).toBe(false);
    expect(service.transcript('dm-forge').filter((entry) => entry.author.role === 'bot')).toEqual(
      [],
    );
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({ text: 'Stopped.' });
    // Both deliveries are withdrawn: the running one as aborted, the queued one
    // without ever starting.
    expect(deliveriesOf(root, 'dm-forge').map((row) => row.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    // The clear is emitted once, by the turn's own teardown.
    expect(events.filter((event) => event.type === 'routing' && event.state === null)).toHaveLength(
      1,
    );
    expect(service.routing('dm-forge')).toBeNull();
  });

  it('stop settles a turn whose engine never reports run-end', async () => {
    const { adapter, service } = harness({
      script: ({ call }) => (call === 1 ? { hold: true, abortSilently: true } : { text: 'ok' }),
    });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;

    service.stop('dm-forge');
    await settle(service);

    // The abort resolved without a run-end; the lane still has to settle,
    // otherwise every later delivery would wait behind it forever.
    expect(gateway.aborted).toBe(true);
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'system' },
      text: 'Stopped.',
    });

    await service.send('dm-forge', 'again');
    await settle(service);
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'ok',
    });
  });

  it('stops one bot in one conversation and leaves every other bot and room working', async () => {
    const { root, adapter, service } = harness({
      script: () => ({ text: 'late', hold: true }),
    });
    await service.createBot(botInput({ username: 'sigil', name: 'Sigil' }));
    await service.createBot(botInput({ username: 'loom', name: 'Loom' }));
    const shop = service.createGroup({ name: 'Shop', members: ['sigil', 'loom'] });
    const second = service.createGroup({ name: 'Second', members: ['sigil'] });

    // Two lanes run side by side, and Sigil's is already busy when its other
    // room asks for it.
    await service.send(shop.id, '@sigil @loom go');
    const sigil = gatewayFor(adapter, 'sigil');
    const loom = gatewayFor(adapter, 'loom');
    await sigil.prompted;
    await loom.prompted;
    await service.send(second.id, '@sigil go');
    expect(deliveriesOf(root, second.id).map((row) => row.status)).toEqual(['queued']);

    service.stop(shop.id, 'sigil');

    // Only the named bot's delivery in this room was withdrawn; Loom was never
    // asked to stop, so its turn keeps running.
    const shopRows = deliveriesOf(root, shop.id);
    expect(shopRows.find((row) => row.to === 'sigil')?.status).toBe('cancelled');
    expect(shopRows.find((row) => row.to === 'loom')?.status).toBe('running');
    expect(sigil.aborted).toBe(true);
    expect(loom.aborted).toBe(false);

    // The other room's engine is the lane's next gateway; the first one was
    // aborted and holds nothing any more.
    for (let tick = 0; tick < 200 && factoryFor(adapter, 'sigil').gateways.length < 2; tick += 1) {
      await Promise.resolve();
    }
    const secondGateway = gatewayFor(adapter, 'sigil', 1);
    await secondGateway.prompted;
    // The stopped lane is free, so the bot's work in the other room starts rather
    // than being cancelled with it.
    expect(deliveriesOf(root, second.id).map((row) => row.status)).toEqual(['running']);
    secondGateway.release();
    gatewayFor(adapter, 'loom').release();
    await settle(service, shop.id);
    await settle(service, second.id);

    // A late settle from the aborted engine cannot bring the cancelled row back.
    expect(deliveriesOf(root, shop.id).find((row) => row.to === 'sigil')?.status).toBe('cancelled');
  });

  it('stop without a username cancels every bot in that conversation only', async () => {
    const { root, adapter, service } = harness({
      script: () => ({ text: 'late', hold: true }),
    });
    await twoBots(service);
    const launch = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const other = service.createGroup({ name: 'Other', members: ['forge'] });

    await service.send(launch.id, '@all go');
    await gatewayFor(adapter, 'forge').prompted;
    await gatewayFor(adapter, 'sable').prompted;
    await service.send(other.id, '@forge queued');
    expect(deliveriesOf(root, other.id).map((row) => row.status)).toEqual(['queued']);

    service.stop(launch.id);
    await settle(service, launch.id);

    expect(deliveriesOf(root, launch.id).map((row) => row.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    // The whole room was stopped, not the bots' work everywhere: Forge's lane
    // takes its next delivery and the other room starts.
    expect(deliveriesOf(root, other.id).map((row) => row.status)).toEqual(['running']);

    for (let tick = 0; tick < 200 && factoryFor(adapter, 'forge').gateways.length < 2; tick += 1) {
      await Promise.resolve();
    }
    const otherGateway = gatewayFor(adapter, 'forge', 1);
    await otherGateway.prompted;
    otherGateway.release();
    await settle(service, other.id);
  });

  it('stopping a bot that is not running in the room is a no-op', async () => {
    const { root, adapter, service } = harness({
      script: () => ({ text: 'late', hold: true }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    await service.send(group.id, '@forge hold');
    await gatewayFor(adapter, 'forge').prompted;
    const before = deliveriesOf(root, group.id);
    const notes = (): number =>
      service.transcript(group.id).filter((entry) => entry.author.role === 'system').length;
    expect(notes()).toBe(0);

    service.stop(group.id, 'sable');

    // Nothing to stop, so nothing changes: no row, no note, no routing event and
    // no engine told to abort.
    expect(deliveriesOf(root, group.id)).toEqual(before);
    expect(notes()).toBe(0);
    expect(service.routing(group.id)?.active.map((one) => one.target)).toEqual(['Forge']);
    expect(gatewayFor(adapter, 'forge').aborted).toBe(false);

    gatewayFor(adapter, 'forge').release();
    await settle(service, group.id);
  });

  it('drops a bot’s oldest queued ask when its queue is full, and keeps the newcomer', async () => {
    const { root, adapter, service } = harness({
      script: ({ call }) => (call === 1 ? { text: 'late', hold: true } : { text: 'ok' }),
    });
    await service.createBot(botInput());
    // One held turn, then enough sends to fill the queue to its cap.
    await service.send('dm-forge', 'running');
    await gatewayFor(adapter, 'forge').prompted;
    for (let index = 0; index < 33; index += 1) {
      await service.send('dm-forge', `queued ${index}`);
    }

    // The newcomer was taken, and the oldest queued row gave way with a note that
    // names the bot, its root and the reason the row was waiting for.
    const rows = deliveriesOf(root, 'dm-forge');
    expect(rows.filter((row) => row.status === 'queued')).toHaveLength(32);
    const dropped = rows.filter((row) => row.status === 'dropped');
    expect(dropped).toHaveLength(1);
    const note = service
      .transcript('dm-forge')
      .filter((entry) => entry.author.role === 'system')
      .map((entry) => entry.text)
      .at(-1);
    expect(note).toContain('Forge');
    expect(note).toContain(dropped[0]?.rootId);
    expect(note).toContain('direct');
    gatewayFor(adapter, 'forge').release();
    await settle(service);
  });

  it('prunes finished deliveries on a later send, keeping queued and running ones', async () => {
    let now = 1_000_000;
    const { root, adapter, service } = harness({
      now: () => now,
      script: ({ bot, call }) =>
        bot === 'forge'
          ? call === 1
            ? { text: 'busy', hold: true }
            : { text: 'ok' }
          : { text: `sable ${call}` },
    });
    await twoBots(service);

    // One finished turn, then a running one with an ask behind it.
    await service.send('dm-sable', 'first');
    await settle(service, 'dm-sable');
    expect(deliveriesOf(root, 'dm-sable').map((row) => row.status)).toEqual(['done']);
    await service.send('dm-forge', 'held');
    await gatewayFor(adapter, 'forge').prompted;
    await service.send('dm-forge', 'waiting');

    // A day later, the next send is the moment a live host pays for housekeeping.
    now += DELIVERY_TTL_MS + 1;
    await service.send('dm-sable', 'second');
    await settle(service, 'dm-sable');

    // The finished row is gone; the two forge rows were never terminal, so they
    // are still exactly where their lane left them.
    const sableRows = deliveriesOf(root, 'dm-sable');
    expect(sableRows).toHaveLength(1);
    expect(sableRows[0]?.status).toBe('done');
    expect(deliveriesOf(root, 'dm-forge').map((row) => row.status)).toEqual([
      'running',
      'queued',
    ]);

    gatewayFor(adapter, 'forge').release();
    await settle(service);
  });

  it('clearing a room whose only work is queued clears its routing state', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'busy', hold: true }) });
    await service.createBot(botInput());
    const group = service.createGroup({ name: 'Launch', members: ['forge'] });
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    // The bot's lane is busy in its DM, so the group's ask waits with no turn of
    // its own in that room.
    await service.send('dm-forge', 'hold the lane');
    await gatewayFor(adapter, 'forge').prompted;
    await service.send(group.id, '@forge queued');
    expect(service.routing(group.id)).toMatchObject({ active: [], queued: ['Forge'] });
    expect(events).toContainEqual({
      type: 'routing',
      conversationId: group.id,
      state: expect.objectContaining({ active: [], queued: ['Forge'] }),
    });

    await service.clear(group.id);

    // Nothing is running there to tear down, so the clear has to come from the
    // withdrawal itself — otherwise the row stays "Answering…" and its menu stays
    // disabled until something unrelated happens in the room.
    expect(service.routing(group.id)).toBeNull();
    expect(events).toContainEqual({
      type: 'routing',
      conversationId: group.id,
      state: null,
    });

    service.stop('dm-forge');
    await settle(service);
  });
});

describe('BotService sessions', () => {
  it('resume reuses stored engine session ids', async () => {
    const { root, service } = harness({ script: () => ({ text: 'ok' }) });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await settle(service);
    const stored = loadBotRegistry(root).conversations[0]?.sessions['forge']?.engineSessionId;
    expect(stored).toBe('forge-session-1');

    await service.dispose();

    const restartedAdapter = new FakeAdapter(() => ({ text: 'again' }), {
      script: () => ({ text: 'again' }),
    });
    const restarted = serviceOn(root, restartedAdapter);
    registerService(restarted);
    await restarted.send('dm-forge', 'again');
    await settle(restarted);

    const resumed = factoryFor(restartedAdapter, 'forge');
    expect(resumed.createCalls).toHaveLength(1);
    expect(resumed.createCalls[0]?.sessionId).toBe(stored);
  });

  it('two bots on one engine kind get independent gateways', async () => {
    const { root, adapter, service } = harness();
    await twoBots(service);

    await service.send('dm-forge', 'hi');
    await settle(service);
    await service.send('dm-sable', 'hi');
    await settle(service, 'dm-sable');

    const forge = factoryFor(adapter, 'forge');
    const sable = factoryFor(adapter, 'sable');
    expect(forge).not.toBe(sable);
    expect(forge.botRoot).toBe(join(root, 'forge'));
    expect(sable.botRoot).toBe(join(root, 'sable'));
    expect(forge.gateways[0]).not.toBe(sable.gateways[0]);
    expect(forge.gateways[0]?.prompts).toEqual(['[Forge] You: hi']);
    expect(sable.gateways[0]?.prompts).toEqual(['[Sable] You: hi']);
  });

  it('sends only what the reader typed: the persona is the engine own file', async () => {
    const { adapter, service } = harness();
    await service.createBot(botInput({ persona: 'You are Forge, the builder.' }));

    await service.send('dm-forge', 'hi');
    await settle(service);
    await service.send('dm-forge', 'again');
    await settle(service);

    // The persona is not prefixed onto a prompt: it goes into the engine's own
    // instruction file (pi's agent-dir AGENTS.md, OpenCode's `instructions`), so
    // the engine applies it exactly as it would for a hand-built agent.
    expect(gatewayFor(adapter, 'forge').prompts).toEqual(['[Forge] You: hi', '[Forge] You: again']);
    expect(adapter.layout.writes[0]?.config.persona).toBe('You are Forge, the builder.');
  });

  it('a thinking level the model lacks is noted, not fatal', async () => {
    const { adapter, service } = harness({
      thinkingUnsupported: true,
      script: () => ({ text: 'Still answered.' }),
    });
    await service.createBot(botInput({ thinkingLevel: 'medium' }));

    await service.send('dm-forge', 'hi');
    await settle(service);

    const gateway = gatewayFor(adapter, 'forge');
    expect(gateway.levelsApplied).toEqual([]);
    const entries = service.transcript('dm-forge');
    expect(entries.map((entry) => entry.text)).toContain(
      'Thinking level "medium" is not available on this model — using the engine default.',
    );
    expect(entries.at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'Still answered.',
    });
  });

  it('clear deletes the transcript, the engine sessions and the pointers', async () => {
    const { root, adapter, service } = harness({ script: () => ({ text: 'kept for now' }) });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await settle(service);
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.clear('dm-forge');

    // Nothing is left to read: not in memory, not in the file on disk.
    expect(service.transcript('dm-forge')).toEqual([]);
    expect(
      existsSync(join(root, 'transcripts', 'dm-forge.jsonl')),
    ).toBe(false);
    // The engine's own session goes too — this is the gesture that forgets, so a
    // later message must not resume what was just deleted.
    const factory = factoryFor(adapter, 'forge');
    expect(factory.removedSessions).toEqual(['forge-session-1']);
    expect(factory.gateways[0]?.disposed).toBe(true);
    expect(loadBotRegistry(root).conversations[0]?.sessions).toEqual({});
    // The room survives: the reader asked to forget the words, not the bot.
    expect(service.roster().conversations.map((one) => one.id)).toEqual(['dm-forge']);
    // The client is told the page it holds is wrong, which only `replace` says.
    expect(events).toContainEqual({
      type: 'transcript',
      conversationId: 'dm-forge',
      entries: [],
      replace: true,
    });
    expect(service.usage('dm-forge')).toBeUndefined();
  });

  it('clear ends a round in flight before the file goes', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'still talking', hold: true }) });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await gatewayFor(adapter, 'forge').prompted;

    await service.clear('dm-forge');
    await settle(service);

    // The turn in flight cannot append to a transcript that no longer exists, and
    // neither can a note it would have written.
    expect(service.transcript('dm-forge')).toEqual([]);
    expect(service.routing('dm-forge')).toBeNull();
  });

  it('clear of an unknown conversation is refused rather than silent', async () => {
    const { service } = harness();

    await expect(service.clear('dm-ghost')).rejects.toThrow('No bot conversation');
  });

  it('clear rejects when the registry cannot be written', async () => {
    const { service, root } = harness();
    await service.createBot(botInput());
    blockRegistryWrites(root);

    // The transcript is gone but the pointers that named its sessions were not
    // saved; the caller must hear that, not just the log.
    await expect(service.clear('dm-forge')).rejects.toThrow(/registry\.json/);
  });

  it('compact asks every member engine to summarise, and says so', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'noted' }) });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    // Both members answer once, so both have a session with something in it.
    await service.send(group.id, '@forge hello');
    await settle(service, group.id);
    await service.send(group.id, '@sable hello');
    await settle(service, group.id);
    const before = factoryFor(adapter, 'forge').gateways[0];
    expect(before?.compacted).toBe(0);

    await service.compact(group.id);

    // The warm gateway is reused: compaction is a model call on the session that
    // already holds the context, not a reason to start another one.
    expect(before?.compacted).toBe(1);
    expect(gatewayFor(adapter, 'sable').compacted).toBe(1);
    expect(factoryFor(adapter, 'forge').gateways).toHaveLength(1);
    expect(service.transcript(group.id).map((entry) => entry.text)).toContain(
      'Compacted. The engine summarised what it held.',
    );
  });

  it('compact starts a cold member from its stored session, and skips one with none', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'noted' }) });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    await service.send(group.id, '@forge hello');
    await settle(service, group.id);
    // Sable never answered, so the engine session it would compact does not exist.

    await service.compact(group.id);

    expect(factoryFor(adapter, 'forge').gateways[0]?.compacted).toBe(1);
    // Starting Sable would have made its engine mint a session: less context is
    // the gesture, a new session is not.
    expect(factoryFor(adapter, 'sable').createCalls).toHaveLength(0);
  });

  it('compact on a conversation where nobody answered says so instead of nothing', async () => {
    const { service } = harness();
    await service.createBot(botInput());

    await service.compact('dm-forge');

    expect(service.transcript('dm-forge').map((entry) => entry.text)).toEqual([
      'Nothing to compact yet — no bot has answered here.',
    ]);
  });

  it('compact waits for a quiet conversation instead of dropping the answer', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'busy', hold: true }) });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await gatewayFor(adapter, 'forge').prompted;

    await service.compact('dm-forge');

    // pi compacts by aborting the run in flight, so a round under way means later.
    expect(gatewayFor(adapter, 'forge').compacted).toBe(0);
    expect(service.transcript('dm-forge').map((entry) => entry.text)).toContain(
      'A round is running in this conversation — compact once it ends.',
    );
    service.stop('dm-forge');
    await settle(service);
  });

  it('an engine that cannot compact is noted, and the round is not failed', async () => {
    const { service } = harness({
      compactUnsupported: true,
      script: () => ({ text: 'noted' }),
    });
    await service.createBot(botInput());
    // A session to compact: the engine's refusal is what this test is about.
    await service.send('dm-forge', 'hi');
    await settle(service);

    await expect(service.compact('dm-forge')).resolves.toBeUndefined();

    expect(service.transcript('dm-forge').map((entry) => entry.text)).toContain(
      "Forge's engine cannot compact this session",
    );
  });

  it('pushes what a turn cost, per conversation, and remembers it for an open', async () => {
    const { adapter, service } = harness({
      sessionUsage: {
        usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
        contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
        costUsd: 0.02,
        model: MODEL,
      },
      script: () => ({ text: 'done' }),
    });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await gatewayFor(adapter, 'forge').prompted;
    await settle(service);

    // The counters belong to a bot's engine session, so the push names it: a
    // group's ring says whose window it is drawing.
    expect(service.usage('dm-forge')).toMatchObject({
      conversationId: 'dm-forge',
      bot: 'Forge',
      usage: { totalTokens: 1000 },
      contextUsage: { percent: 0.5 },
      costUsd: 0.02,
      model: MODEL,
    });
  });

  it('newDiscussion starts fresh sessions', async () => {
    const { root, adapter, service } = harness();
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    await settle(service);
    const before = loadBotRegistry(root).conversations[0]?.sessions['forge']?.engineSessionId;

    service.newDiscussion('dm-forge');
    await service.send('dm-forge', 'again');
    await settle(service);

    const factory = factoryFor(adapter, 'forge');
    expect(factory.createCalls).toHaveLength(2);
    expect(factory.createCalls[1]?.sessionId).toBeUndefined();
    expect(factory.gateways[0]?.disposed).toBe(true);
    const after = loadBotRegistry(root).conversations[0]?.sessions['forge']?.engineSessionId;
    expect(after).not.toBe(before);
    expect(after).toBe('forge-session-2');
  });

  it('newDiscussion withdraws the queued asks and starts fresh sessions', async () => {
    const { root, adapter, service } = harness({
      script: ({ bot }) =>
        bot === 'forge' ? { text: 'late', hold: true } : { text: 'Sable here' },
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    await service.send(group.id, '@forge go');
    await service.send(group.id, '@forge again');
    const forge = gatewayFor(adapter, 'forge');
    await forge.prompted;

    service.newDiscussion(group.id);
    await settle(service, group.id);

    // The queued ask must not be delivered on the sessions just abandoned.
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
    expect(forge.prompts).toHaveLength(1);
    expect(forge.disposed).toBe(true);
    expect(deliveriesOf(root, group.id).map((row) => row.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    // The boundary is a divider in the same transcript, so one chat reads as the
    // sequence of engine sessions it is.
    expect(service.transcript(group.id).map((entry) => entry.author.role)).toEqual([
      'user',
      'user',
      'discussion',
    ]);
    expect(service.transcript(group.id).map((entry) => entry.text)).toEqual([
      '@forge go',
      '@forge again',
      'New discussion',
    ]);
  });

  it('keeps a conversation across a restart, and marks a new discussion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morse-bot-restart-'));
    const first = serviceOn(dir, new FakeAdapter(() => ({ text: 'Done.' })));
    registerService(first);
    await first.createBot(botInput());
    await first.send('dm-forge', 'hi');
    await settle(first);
    first.newDiscussion('dm-forge');
    await first.dispose();

    // A new service over the same directory: the transcript is a file, not a map.
    const second = serviceOn(dir, new FakeAdapter(() => ({ text: 'Again.' })));
    registerService(second);

    const roles = second.transcript('dm-forge').map((entry) => entry.author.role);
    expect(roles).toEqual(['user', 'bot', 'discussion']);
    expect(second.transcript('dm-forge').map((entry) => entry.text)).toEqual([
      'hi',
      'Done.',
      'New discussion',
    ]);

    // Opening it shows the newest page; scrolling up asks for the one before it.
    const opened = second.open('dm-forge', 2);
    expect(opened.entries.map((entry) => entry.text)).toEqual(['Done.', 'New discussion']);
    expect(opened.hasMore).toBe(true);
    const older = second.history('dm-forge', opened.entries[0]?.id, 2);
    expect(older.entries.map((entry) => entry.text)).toEqual(['hi']);
    expect(older.hasMore).toBe(false);

    await second.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('idle gateway is disposed after idleMs', async () => {
    vi.useFakeTimers();
    const { adapter, service } = harness({ idleMs: 1_000 });
    await service.createBot(botInput());

    await service.send('dm-forge', 'hi');
    await settle(service);
    const gateway = gatewayFor(adapter, 'forge');
    expect(service.roster().bots[0]?.warm).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(gateway.disposed).toBe(false);

    await service.send('dm-forge', 'again');
    await settle(service);
    await vi.advanceTimersByTimeAsync(999);
    expect(gateway.disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.disposed).toBe(true);
    expect(service.roster().bots[0]?.warm).toBe(false);
  });
});

/**
 * The two bots the bus tests talk through, with the spec's own example names:
 * Sigil is the caller, Loom the teammate it reaches.
 */
async function busBots(service: BotService): Promise<void> {
  await service.createBot(
    botInput({ username: 'sigil', name: 'Sigil', description: 'Crafts bot names & identities' }),
  );
  await service.createBot(
    botInput({ username: 'loom', name: 'Loom', description: 'Weaves long threads' }),
  );
}

/**
 * Waits until a bot's turn file exists — the same signal a live engine's tool
 * call would have. The file is written before the prompt, so a turn that has one
 * is a turn the bus may answer inside.
 */
async function waitForTurn(service: BotService, username: string): Promise<void> {
  const { turnFile } = service.botBusPaths(username);
  for (let tick = 0; tick < 500; tick += 1) {
    if (existsSync(turnFile)) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`${username}'s turn never wrote its turn file.`);
}

/**
 * Starts one bot's turn and holds it open, so a bus call has the live turn the
 * real plugin always has. Returns the gateway a test releases (or aborts) to let
 * the lane finish.
 */
async function holdTurn(
  service: BotService,
  adapter: FakeAdapter,
  conversationId: string,
  username: string,
  index = 0,
): Promise<FakeGateway> {
  await service.send(conversationId, `@${username} hold this turn`);
  await waitForTurn(service, username);
  return gatewayFor(adapter, username, index);
}

/**
 * Holds the turn a person started and answers one a bot started: a bus call
 * happens inside a prompt, so only the turn a test opens has to stay live.
 */
const holdsPersonTurns: Script = ({ prompt }) =>
  prompt.startsWith('[From ') ? { text: 'answered' } : { text: 'held', hold: true };

describe('BotService bus', () => {
  it('lists the roster with a capped description and no private fields', async () => {
    const { service } = harness();
    await busBots(service);
    await service.createBot(
      botInput({
        username: 'sage',
        name: 'Sage',
        description: 'x'.repeat(BOT_DESCRIPTION_LIMIT + 50),
      }),
    );

    const roster = service.busRoster('sigil');
    const loom = roster.find((entry) => entry.username === 'loom');
    const sage = roster.find((entry) => entry.username === 'sage');

    // Only what a sender decides on: no credentials, engine, workspace or rooms.
    expect(loom).toEqual({
      username: 'loom',
      name: 'Loom',
      description: 'Weaves long threads',
      state: 'idle',
      queued: 0,
      inRoom: false,
    });
    expect(loom).not.toHaveProperty('credentialEnv');
    expect(loom).not.toHaveProperty('engineKind');
    expect(sage?.description).toHaveLength(BOT_DESCRIPTION_LIMIT);
    expect(roster.map((entry) => entry.username)).toEqual(['sigil', 'loom', 'sage']);
  });

  it('reports a bot as working while its lane runs and queued while work waits', async () => {
    const { adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);

    await holdTurn(service, adapter, 'dm-sigil', 'sigil');
    await service.send('dm-sigil', 'one more thing');

    const roster = service.busRoster('sigil');
    expect(roster.find((entry) => entry.username === 'sigil')).toMatchObject({
      state: 'working',
      queued: 1,
    });
    expect(roster.find((entry) => entry.username === 'loom')).toMatchObject({
      state: 'idle',
      queued: 0,
    });

    service.stop('dm-sigil');
    await settle(service, 'dm-sigil');
  });

  it('sends into the room the caller is answering in', async () => {
    const { root, adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['sigil', 'loom'] });
    const held = await holdTurn(service, adapter, group.id, 'sigil');

    const result = await service.busSend('sigil', { to: 'loom', text: 'name it' });

    expect(result).toMatchObject({ conversationId: group.id, queued: true });
    const rows = deliveriesOf(root, group.id);
    const sent = rows.find((row) => row.id === result.deliveryId);
    // The room shows who asked whom, and the delivery points at that line.
    const line = service
      .transcript(group.id)
      .find((entry) => entry.id === sent?.entryId);
    expect(line).toMatchObject({
      author: { role: 'bot', name: 'Sigil', username: 'sigil' },
      text: '@loom name it',
    });
    expect(sent).toMatchObject({
      conversationId: group.id,
      entryId: line?.id,
      from: { type: 'bot', username: 'sigil' },
      to: 'loom',
      kind: 'message',
      reason: 'bot',
      depth: 1,
    });
    // One trigger, one root: the send descends from the turn it was made in.
    expect(sent?.rootId).toBe(rows[0]?.rootId);
    expect(rows[0]?.depth).toBe(0);

    held.release();
    await settle(service, group.id);
  });

  it('opens a thread when the target is not in the caller’s room', async () => {
    const { root, adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);
    await holdTurn(service, adapter, 'dm-sigil', 'sigil');

    const result = await service.busSend('sigil', { to: 'loom', text: 'outside' });

    const thread = service.roster().conversations.find((one) => one.id === result.conversationId);
    expect(result).toMatchObject({ conversationId: 'thread-loom-sigil', queued: true });
    // The pair, sorted, so either bot's send finds the same room — and the title
    // follows that same member order.
    expect(thread).toMatchObject({
      id: 'thread-loom-sigil',
      kind: 'thread',
      title: 'Loom · Sigil',
      members: ['loom', 'sigil'],
    });
    const [sent] = deliveriesOf(root, 'thread-loom-sigil');
    expect(sent).toMatchObject({
      conversationId: 'thread-loom-sigil',
      from: { type: 'bot', username: 'sigil' },
      to: 'loom',
      reason: 'bot',
      depth: 1,
    });
    // A thread has content from its first line.
    expect(
      service.transcript('thread-loom-sigil').find((entry) => entry.id === sent?.entryId),
    ).toMatchObject({ text: '@loom outside' });

    service.stop('dm-sigil');
    service.stop('thread-loom-sigil');
    await settle(service, 'dm-sigil');
    await settle(service, 'thread-loom-sigil');
  });

  it('refuses a thread id that already belongs to another pair', async () => {
    const { adapter, service } = harness({ script: holdsPersonTurns });
    // Hyphenated usernames make the id ambiguous: these two different pairs both
    // spell `thread-a-b-c`.
    await service.createBot(botInput({ username: 'a-b', name: 'A B', description: 'First pair' }));
    await service.createBot(botInput({ username: 'c', name: 'C', description: 'First pair' }));
    await service.createBot(botInput({ username: 'a', name: 'A', description: 'Second pair' }));
    await service.createBot(botInput({ username: 'b-c', name: 'B C', description: 'Second pair' }));

    await holdTurn(service, adapter, 'dm-a-b', 'a-b');
    const first = await service.busSend('a-b', { to: 'c', text: 'hello c' });
    expect(first.conversationId).toBe('thread-a-b-c');

    await holdTurn(service, adapter, 'dm-a', 'a');
    const refusal = await service
      .busSend('a', { to: 'b-c', text: 'collide' })
      .catch((error: unknown) => error);

    // The other pair's private room is never written into; the sender is told
    // why rather than having its line delivered to a stranger.
    expect(refusal).toBeInstanceOf(BotBusError);
    expect((refusal as BotBusError).reason).toContain('another pair');
    expect(
      service.roster().conversations.find((one) => one.id === 'thread-a-b-c'),
    ).toMatchObject({ kind: 'thread', members: ['a-b', 'c'] });
    // The first pair's room holds its own line and nothing from the other pair.
    const lines = service.transcript('thread-a-b-c');
    expect(lines[0]).toMatchObject({ text: '@c hello c' });
    expect(lines.some((entry) => entry.text.includes('collide'))).toBe(false);

    service.stop('dm-a-b');
    service.stop('dm-a');
    service.stop('thread-a-b-c');
    await settle(service, 'dm-a-b');
    await settle(service, 'dm-a');
    await settle(service, 'thread-a-b-c');
  });

  it('reuses one thread when both bots send again', async () => {
    const { adapter, service } = harness({
      script: ({ bot, prompt }) => {
        const fromBot = prompt.startsWith('[From ');
        return bot === 'sigil'
          ? { text: 'sigil here', hold: !fromBot }
          : { text: 'loom here', hold: fromBot };
      },
    });
    await busBots(service);

    // Sigil asks from its own DM, so the room it answers in is not Loom's.
    await holdTurn(service, adapter, 'dm-sigil', 'sigil');
    const first = await service.busSend('sigil', { to: 'loom', text: 'first' });
    await waitForTurn(service, 'loom');
    // Loom answers from inside its own held turn: the other direction, same room.
    const second = await service.busSend('loom', { to: 'sigil', text: 'second' });
    expect(second.conversationId).toBe(first.conversationId);

    gatewayFor(adapter, 'sigil', 0).release();
    gatewayFor(adapter, 'loom', 0).release();
    await settle(service, first.conversationId);
    await settle(service, 'dm-sigil');

    // A second turn, a second send from Sigil: the same pair is still one room.
    await holdTurn(service, adapter, 'dm-sigil', 'sigil');
    const third = await service.busSend('sigil', { to: 'loom', text: 'third' });
    expect(third.conversationId).toBe(first.conversationId);
    expect(service.roster().conversations.filter((one) => one.kind === 'thread')).toHaveLength(1);
    expect(service.roster().conversations.find((one) => one.id === first.conversationId)).toMatchObject(
      { kind: 'thread', members: ['loom', 'sigil'] },
    );

    service.stop('dm-sigil');
    service.stop(first.conversationId);
    await settle(service, 'dm-sigil');
    await settle(service, first.conversationId);
  });

  it('takes a thread with a bot that is deleted', async () => {
    const { root, adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);
    await holdTurn(service, adapter, 'dm-sigil', 'sigil');
    const thread = await service.busSend('sigil', { to: 'loom', text: 'see you' });

    await service.deleteBot('loom');

    // A thread is a private pair: one member left is not a room, so it goes with
    // the bot instead of becoming a one-sided conversation nobody can answer in.
    expect(service.roster().conversations.some((one) => one.id === thread.conversationId)).toBe(
      false,
    );
    expect(loadBotRegistry(root).conversations.map((one) => one.id)).toEqual(['dm-sigil']);
    expect(deliveriesOf(root, thread.conversationId)).toEqual([]);

    service.stop('dm-sigil');
    await settle(service, 'dm-sigil');
  });

  it('refuses a self-send with a readable reason', async () => {
    const { adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);
    await holdTurn(service, adapter, 'dm-sigil', 'sigil');

    const refusal = await service
      .busSend('sigil', { to: 'sigil', text: 'me' })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BotBusError);
    expect((refusal as BotBusError).reason).toBe('a bot cannot send to itself');

    service.stop('dm-sigil');
    await settle(service, 'dm-sigil');
  });

  it('fails a send to a bot that was deleted, and the lane keeps going', async () => {
    const { adapter, service } = harness({
      script: ({ call }) => (call === 1 ? { text: 'held', hold: true } : { text: 'answered' }),
    });
    await busBots(service);
    const held = await holdTurn(service, adapter, 'dm-sigil', 'sigil');

    await service.deleteBot('loom');
    await expect(service.busSend('sigil', { to: 'loom', text: 'gone' })).rejects.toThrow(/unknown/i);

    // The refusal is the caller's problem, not the lane's: the turn it happened
    // inside still settles, and the bot's next message is answered.
    held.release();
    await settle(service, 'dm-sigil');
    await service.send('dm-sigil', 'again');
    await settle(service, 'dm-sigil');
    expect(service.transcript('dm-sigil').filter((entry) => entry.author.role === 'bot')).toHaveLength(
      2,
    );
  });

  it('writes a token file only its own bot can use', async () => {
    const { service } = harness();
    await busBots(service);

    const token = service.issueBusToken('sigil');
    const other = service.issueBusToken('loom');

    expect(service.resolveBusToken(token)).toBe('sigil');
    expect(service.resolveBusToken(other)).toBe('loom');
    expect(service.resolveBusToken('not-a-token')).toBeUndefined();
    const paths = service.botBusPaths('sigil');
    if (process.platform !== 'win32') {
      expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(paths.tokenFile, 'utf8')).toBe(token);

    // One live credential per bot: minting again retires the old token.
    const again = service.issueBusToken('sigil');
    expect(service.resolveBusToken(again)).toBe('sigil');
    expect(service.resolveBusToken(token)).toBeUndefined();
    expect(service.resolveBusToken(other)).toBe('loom');
  });

  it('mints a bot its own token when its engine starts', async () => {
    const { service } = harness({ script: () => ({ text: 'ok' }) });
    await busBots(service);

    await service.send('dm-sigil', 'hi');
    await settle(service, 'dm-sigil');

    const token = readFileSync(service.botBusPaths('sigil').tokenFile, 'utf8');
    expect(service.resolveBusToken(token)).toBe('sigil');
    // Loom's engine never started, so no token of its own exists.
    expect(existsSync(service.botBusPaths('loom').tokenFile)).toBe(false);
  });

  it('hands a bot the bus names and leaves the engine probe without them', async () => {
    const { root, adapter, service } = harness({ busEndpoint: 'http://127.0.0.1:4319' });
    await service.createBot(
      botInput({ username: 'sigil', name: 'Sigil', description: 'Crafts bot names & identities' }),
    );

    const env = adapter.envs[0];
    expect(env?.['MORSE_BUS_URL']).toBe('http://127.0.0.1:4319');
    expect(env?.['MORSE_BUS_TOKEN_FILE']).toBe(join(root, 'sigil', 'config', '.morse-bus-token'));
    expect(env?.['MORSE_BUS_TURN_FILE']).toBe(join(root, 'sigil', 'config', '.morse-bus-turn.json'));

    // The wizard's probe asks about an engine, not about a bot, so it has no bot
    // directory whose token it could read and no room it could answer in.
    await service.probeModels('fake', [], [{ provider: 'anthropic', apiKey: 'sk-ant' }]);
    const probe = adapter.envs.at(-1);
    expect(probe?.['MORSE_BUS_URL']).toBeUndefined();
    expect(probe?.['MORSE_BUS_TOKEN_FILE']).toBeUndefined();
    expect(probe?.['MORSE_BUS_TURN_FILE']).toBeUndefined();
  });

  it('writes the turn file for the delivery it answers and removes it when the turn ends', async () => {
    const { root, adapter, service } = harness({
      now: () => 1_000_000,
      turnTimeoutMs: 5_000,
      script: holdsPersonTurns,
    });
    await service.createBot(
      botInput({ username: 'sigil', name: 'Sigil', description: 'Crafts bot names & identities' }),
    );
    const held = await holdTurn(service, adapter, 'dm-sigil', 'sigil');

    const paths = service.botBusPaths('sigil');
    if (process.platform !== 'win32') {
      expect(statSync(paths.turnFile).mode & 0o777).toBe(0o600);
    }
    const [row] = deliveriesOf(root, 'dm-sigil');
    expect(JSON.parse(readFileSync(paths.turnFile, 'utf8'))).toEqual({
      deliveryId: row?.id,
      conversationId: 'dm-sigil',
      rootId: row?.rootId,
      depth: 0,
      expiresAt: 1_005_000,
    });

    held.release();
    await settle(service, 'dm-sigil');
    expect(existsSync(paths.turnFile)).toBe(false);
  });

  it('refuses a bus call without a live turn, or after the turn file has expired', async () => {
    const now = 1_000_000;
    const { adapter, service } = harness({
      now: () => now,
      turnTimeoutMs: 5_000,
      script: holdsPersonTurns,
    });
    await busBots(service);

    await expect(service.busSend('sigil', { to: 'loom', text: 'nowhere' })).rejects.toThrow(
      'no active turn',
    );

    await holdTurn(service, adapter, 'dm-sigil', 'sigil');
    const paths = service.botBusPaths('sigil');
    const live = JSON.parse(readFileSync(paths.turnFile, 'utf8'));

    // Unreadable: a half-written or hand-broken file is not a room to guess at.
    writeFileSync(paths.turnFile, 'not a turn');
    await expect(service.busSend('sigil', { to: 'loom', text: 'broken' })).rejects.toThrow(
      'no active turn',
    );

    // Expired: the turn it named may already be gone, so it is refused too.
    writeFileSync(paths.turnFile, JSON.stringify({ ...live, expiresAt: now - 1 }));
    await expect(service.busSend('sigil', { to: 'loom', text: 'late' })).rejects.toThrow(
      'no active turn',
    );

    // The same live turn, in time, is answered: those refusals were about the
    // file, not about the bot.
    writeFileSync(paths.turnFile, JSON.stringify(live));
    await expect(service.busSend('sigil', { to: 'loom', text: 'in time' })).resolves.toMatchObject({
      conversationId: 'thread-loom-sigil',
      queued: true,
    });

    service.stop('dm-sigil');
    service.stop('thread-loom-sigil');
    await settle(service, 'dm-sigil');
    await settle(service, 'thread-loom-sigil');
  });

  it('refuses a turn file whose trigger or depth was edited', async () => {
    const { adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['sigil', 'loom'] });
    await holdTurn(service, adapter, group.id, 'sigil');
    const paths = service.botBusPaths('sigil');
    const live = JSON.parse(readFileSync(paths.turnFile, 'utf8'));

    // A fresh root at depth 0 would opt this send out of both loop backstops
    // while still naming the delivery the lane is really running. The delivery
    // is the authority on both, so the file is refused.
    writeFileSync(paths.turnFile, JSON.stringify({ ...live, depth: 0, rootId: 'fresh-root' }));
    await expect(service.busSend('sigil', { to: 'loom', text: 'reset' })).rejects.toThrow(
      'no active turn',
    );

    // Either one alone is already a file this turn did not write.
    writeFileSync(paths.turnFile, JSON.stringify({ ...live, depth: live.depth + 1 }));
    await expect(service.busSend('sigil', { to: 'loom', text: 'deeper' })).rejects.toThrow(
      'no active turn',
    );
    writeFileSync(paths.turnFile, JSON.stringify({ ...live, rootId: 'fresh-root' }));
    await expect(service.busSend('sigil', { to: 'loom', text: 'new root' })).rejects.toThrow(
      'no active turn',
    );

    // Restored, it is the live turn again: the refusal is about the file.
    writeFileSync(paths.turnFile, JSON.stringify(live));
    await expect(service.busSend('sigil', { to: 'loom', text: 'honest' })).resolves.toMatchObject({
      conversationId: group.id,
      queued: true,
    });

    service.stop(group.id);
    await settle(service, group.id);
  });

  it('reports inRoom from the live turn and false for everyone without one', async () => {
    const { adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);
    await service.createBot(
      botInput({ username: 'sage', name: 'Sage', description: 'Somewhere else' }),
    );
    const group = service.createGroup({ name: 'Launch', members: ['sigil', 'loom'] });
    const held = await holdTurn(service, adapter, group.id, 'sigil');

    expect(
      service
        .busRoster('sigil')
        .filter((entry) => entry.inRoom)
        .map((entry) => entry.username),
    ).toEqual(['sigil', 'loom']);

    held.release();
    await settle(service, group.id);

    // No turn file, no room: a settled turn leaves `inRoom` false for everyone.
    expect(service.busRoster('sigil').some((entry) => entry.inRoom)).toBe(false);
  });

  it('drops a send one hop past the depth limit, with a note', async () => {
    // A real chain, not a hand-written file: each bot forwards once from inside
    // its own turn, so every delivery's depth is the one the host queued it with.
    let hop = 0;
    let bus: BotService | undefined;
    const sends: Promise<unknown>[] = [];
    const { root, service } = harness({
      script: ({ bot }) => {
        hop += 1;
        const target = bot === 'sigil' ? 'loom' : 'sigil';
        sends.push(bus!.busSend(bot, { to: target, text: `hop ${hop}` }).catch((error: unknown) => error));
        return { text: `${bot} hop ${hop}` };
      },
    });
    bus = service;
    await busBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['sigil', 'loom'] });

    await service.send(group.id, '@sigil start');
    await settle(service, group.id);

    // Five turns: the person's, then four forwards. The fifth forward would be
    // depth 5 — one past the cap — so it is noted and nothing is queued.
    const results = await Promise.all(sends);
    expect(results.at(-1)).toEqual({
      deliveryId: '',
      conversationId: group.id,
      queued: false,
    });
    expect(
      deliveriesOf(root, group.id)
        .filter((row) => row.reason === 'bot')
        .map((row) => row.depth),
    ).toEqual([1, 2, 3, 4]);
    const notes = service
      .transcript(group.id)
      .filter((entry) => entry.author.role === 'system')
      .map((entry) => entry.text);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`past the depth limit of ${BUS_LIMITS.depth}`);
  });

  it('takes the delivery that reaches the per-root limit and drops the next with a note', async () => {
    const { root, adapter, service } = harness({ script: holdsPersonTurns });
    await busBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['sigil', 'loom'] });
    await holdTurn(service, adapter, group.id, 'sigil');

    // The person's line is one delivery of this root; the bot sends fill the
    // rest, and the one that brings the root to its limit is still taken.
    for (let index = 0; index < BUS_LIMITS.perRoot - 1; index += 1) {
      const result = await service.busSend('sigil', { to: 'loom', text: `filled ${index}` });
      expect(result.queued).toBe(true);
    }
    expect(deliveriesOf(root, group.id)).toHaveLength(BUS_LIMITS.perRoot);

    const refused = await service.busSend('sigil', { to: 'loom', text: 'one too many' });

    expect(refused).toEqual({ deliveryId: '', conversationId: group.id, queued: false });
    // Nothing was added: the root stays at its limit, and the room says why.
    expect(deliveriesOf(root, group.id)).toHaveLength(BUS_LIMITS.perRoot);
    expect(
      service
        .transcript(group.id)
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text)
        .some((text) => text.includes(`past its limit of ${BUS_LIMITS.perRoot}`)),
    ).toBe(true);

    service.stop(group.id);
    await settle(service, group.id);
  });

  it('refuses a bot’s sixty-first send in an hour', async () => {
    const { adapter, service } = harness({
      now: () => 1_000_000,
      // Every bot's first turn holds, so Loom's queue stays put while the sends
      // accumulate and each caller remains inside one live turn.
      script: ({ call }) => (call === 1 ? { text: 'held', hold: true } : { text: 'answered' }),
    });
    await busBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['sigil', 'loom'] });

    // A root takes 48 deliveries, the person's line included, so the hour is
    // filled from two roots: 47 here, then 13 more — 60 in all. The one past
    // the hour is the refusal.
    await holdTurn(service, adapter, 'dm-sigil', 'sigil');
    for (let index = 0; index < BUS_LIMITS.perRoot - 1; index += 1) {
      await service.busSend('sigil', { to: 'loom', text: `first root ${index}` });
    }
    service.stop('dm-sigil');
    await settle(service, 'dm-sigil');

    await holdTurn(service, adapter, group.id, 'sigil');
    for (let index = 0; index < BUS_LIMITS.perBotPerHour - (BUS_LIMITS.perRoot - 1); index += 1) {
      await service.busSend('sigil', { to: 'loom', text: `second root ${index}` });
    }

    const refusal = await service
      .busSend('sigil', { to: 'loom', text: 'one too many' })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BotBusError);
    expect((refusal as BotBusError).reason).toContain('last hour');

    service.stop('thread-loom-sigil');
    service.stop(group.id);
    await settle(service, 'thread-loom-sigil');
    await settle(service, group.id);
  });
});

describe('BotService liveness', () => {
  it('a turn the engine never ends is timed out and its gateway dropped', async () => {
    vi.useFakeTimers();
    let turns = 0;
    const { adapter, service } = harness({
      turnTimeoutMs: 1_000,
      script: () => {
        turns += 1;
        return turns === 1 ? { text: 'partial', hold: true } : { text: 'ok' };
      },
    });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;

    await vi.advanceTimersByTimeAsync(1_000);
    await settle(service);

    expect(
      service
        .transcript('dm-forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual(['Turn timed out after 1s']);
    expect(gateway.disposed).toBe(true);
    expect(service.roster().bots[0]?.warm).toBe(false);

    await service.send('dm-forge', 'again');
    await settle(service);
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'ok',
    });
  });

  it('gateway creation that never answers is bounded', async () => {
    vi.useFakeTimers();
    const { adapter, service } = harness({ turnTimeoutMs: 1_000, hangFirstCreate: true });
    await service.createBot(botInput());

    await service.send('dm-forge', 'hi');
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(service);

    expect(
      service
        .transcript('dm-forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual(['Forge could not start: gateway creation timed out after 1s']);
    expect(factoryFor(adapter, 'forge').createCalls).toHaveLength(1);

    await service.send('dm-forge', 'again');
    await settle(service);
    expect(factoryFor(adapter, 'forge').createCalls).toHaveLength(2);
  });
});

describe('BotService interactions', () => {
  it('interaction requests are auto-answered and noted', async () => {
    const requests: AgentInteractionRequest[] = [
      { requestId: 'r1', kind: 'confirm', title: 'Allow the tool?', message: 'Run it?' },
      {
        requestId: 'r2',
        kind: 'select',
        title: 'Pick a model',
        options: [
          { value: 'fast', label: 'Fast' },
          { value: 'slow', label: 'Slow' },
        ],
      },
      { requestId: 'r3', kind: 'input', title: 'Name the release' },
      {
        requestId: 'r4',
        kind: 'editor',
        title: 'Web Search',
        value: 'senior platform engineer jakarta',
      },
      { requestId: 'r5', kind: 'editor', title: 'Edit the notes' },
      {
        requestId: 'r6',
        kind: 'form',
        title: 'Settings',
        fields: [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'seeded', label: 'Seeded', type: 'text', defaultValue: 'from-the-engine' },
          {
            key: 'level',
            label: 'Level',
            type: 'select',
            options: [{ value: 'high', label: 'High' }],
          },
          { key: 'strict', label: 'Strict', type: 'boolean' },
          { key: 'count', label: 'Count', type: 'integer' },
          { key: 'tags', label: 'Tags', type: 'multiselect' },
        ],
      },
    ];
    const { adapter, service } = harness({
      script: () => ({ interactions: requests, text: 'All done.' }),
    });
    await service.createBot(botInput());

    await service.send('dm-forge', 'go');
    await settle(service);

    const gateway = gatewayFor(adapter, 'forge');
    expect(gateway.responses).toEqual([
      { requestId: 'r1', confirmed: true },
      { requestId: 'r2', value: 'fast' },
      { requestId: 'r3', value: '' },
      // An editor prompt is answered with the engine's own draft, not dismissed:
      // a dismissed one loses the tool call (a web search never runs).
      { requestId: 'r4', value: 'senior platform engineer jakarta' },
      { requestId: 'r5', value: '' },
      {
        requestId: 'r6',
        values: {
          name: '',
          seeded: 'from-the-engine',
          level: 'high',
          strict: false,
          count: 0,
          tags: [],
        },
      },
    ]);
    expect(
      service
        .transcript('dm-forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual([
      'Auto-answered: confirmed "Allow the tool?"',
      'Auto-answered: selected the first option of "Pick a model"',
      'Auto-answered: left "Name the release" blank',
      'Auto-answered: filled "Web Search" from its draft',
      'Auto-answered: left "Edit the notes" blank',
      'Auto-answered: filled "Settings" with its defaults',
    ]);
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'All done.',
    });
  });
});

describe('BotService model probes', () => {
  const CREDENTIALS = [{ provider: 'anthropic', apiKey: 'sk-probe' }];

  it('probeModels uses probeDefaults when the factory offers one', async () => {
    const { root, adapter, service } = harness({ models: [MODEL] });

    const models = await service.probeModels('fake', ['ANTHROPIC_API_KEY'], CREDENTIALS);

    expect(models).toEqual([MODEL]);
    const factory = adapter.factories[0];
    expect(factory?.probeCalls).toBe(1);
    expect(factory?.createCalls).toHaveLength(0);
    expect(factory?.probed[0]?.disposed).toBe(true);
    expect(factory?.botRoot.startsWith(join(root, '.probe-'))).toBe(true);
    // The wizard's keys were written into the throwaway root before the engine
    // was asked what it offers, and that root (with its copy of the keys) is gone.
    expect(factory?.credentialsPresent).toBe(true);
    expect(adapter.credentialWrites).toEqual([{ botRoot: factory?.botRoot, entries: CREDENTIALS }]);
    expect(factory?.disposes).toBe(1);
    expect(readdirSync(root).some((name) => name.startsWith('.probe-'))).toBe(false);
  });

  it('probeModels falls back to create, state and dispose without probeDefaults', async () => {
    const { root, adapter, service } = harness({
      models: [MODEL],
      probeDefaults: false,
    });

    const models = await service.probeModels('fake', [], CREDENTIALS);

    expect(models).toEqual([MODEL]);
    const factory = adapter.factories[0];
    expect(factory?.probeCalls).toBe(0);
    expect(factory?.createCalls).toHaveLength(1);
    expect(factory?.gateways[0]?.disposed).toBe(true);
    expect(factory?.credentialsPresent).toBe(true);
    expect(factory?.disposes).toBe(1);
    expect(readdirSync(root).some((name) => name.startsWith('.probe-'))).toBe(false);
  });
});

describe('BotService engine teardown', () => {
  it('createBot failure disposes the factory the probe used', async () => {
    const { adapter, service } = harness({ probeThrows: true });

    await expect(service.createBot(botInput())).rejects.toThrow('probe failed');

    expect(adapter.factories[0]?.disposes).toBe(1);
  });

  it('deleteBot disposes the bot factory once', async () => {
    const { adapter, service } = harness({ models: [MODEL] });
    await service.createBot(botInput());
    const factory = adapter.factories[0];
    expect(factory?.disposes).toBe(0);

    await service.deleteBot('forge');

    expect(factory?.disposes).toBe(1);
    await service.deleteBot('forge').catch(() => undefined);
    expect(factory?.disposes).toBe(1);
  });

  it('dispose disposes every cached factory once', async () => {
    const { adapter, service } = harness({ models: [MODEL] });
    await twoBots(service);
    const factories = adapter.factories.filter((factory) => !factory.botRoot.includes('.probe-'));
    expect(factories).toHaveLength(2);

    await service.dispose();

    expect(factories.map((factory) => factory.disposes)).toEqual([1, 1]);
  });
});
