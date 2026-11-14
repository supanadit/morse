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
  ModelRef,
  PromptDisposition,
  ThinkingLevel,
  WorkspaceRef,
} from '@morse/agent';
import type { BotCreateInput, BotRoutingState, PromptImage } from '@morse/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../logger.js';
import { UnsupportedByHostError } from '../errors.js';
import type { BotEngineAdapter, BotEvent } from './service.js';
import type { BotEngineConfig, BotEngineLayout, BotEngineState } from './types.js';
import { BotService } from './service.js';
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

  forkMessages(): Promise<never[]> {
    return Promise.resolve([]);
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
    this.states.set(botRoot, {
      persona: config.persona,
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
      ...(config.agentsMd === undefined ? {} : { agentsMd: config.agentsMd }),
      ...(config.subagents === undefined ? {} : { subagents: config.subagents }),
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

interface HarnessOptions {
  script?: Script;
  models?: ModelRef[];
  probeDefaults?: boolean;
  probeThrows?: boolean;
  hangFirstCreate?: boolean;
  idleMs?: number;
  turnTimeoutMs?: number;
  chainCap?: number;
  supportsSubagents?: boolean;
  omitSubagentWriter?: boolean;
  thinkingUnsupported?: boolean;
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
    ...(options.chainCap === undefined ? {} : { defaultChainCap: options.chainCap }),
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

  it('createGroup lists the group with its members, lead and chain cap', async () => {
    const { service } = harness();
    await twoBots(service);

    const group = service.createGroup({
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
      chainCap: 3,
    });

    expect(group).toEqual({
      id: expect.stringMatching(/^grp-launch-[0-9a-f]{4}$/) as string,
      kind: 'group',
      title: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
      chainCap: 3,
      updatedAt: expect.any(Number) as number,
    });
    expect(service.roster().conversations).toContainEqual(group);
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

    const before = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
    expect(before?.sessions['forge']?.engineSessionId).toBeDefined();
    const sableSession = before?.sessions['sable']?.engineSessionId;
    const forgeGateway = gatewayFor(adapter, 'forge');

    const updated = await service.updateGroup({
      id: group.id,
      name: 'Launch, revised',
      members: ['sable'],
      lead: 'sable',
      chainCap: 2,
    });

    expect(updated).toMatchObject({
      title: 'Launch, revised',
      members: ['sable'],
      lead: 'sable',
      chainCap: 2,
    });
    const after = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
    expect(after?.sessions['forge']).toBeUndefined();
    expect(after?.sessions['sable']?.engineSessionId).toBe(sableSession);
    expect(forgeGateway.disposed).toBe(true);
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
  it('dm send relays and records the reply', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'Done.' }) });
    await service.createBot(botInput());
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.send('dm-forge', 'hi');

    expect(gatewayFor(adapter, 'forge').prompts).toEqual(['[Forge] You: hi']);
    const entries = service.transcript('dm-forge');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ author: { role: 'user' }, text: 'hi' });
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
      state: {
        conversationId: 'dm-forge',
        target: 'Forge',
        queued: [],
        activity: expect.objectContaining({ kind: 'starting' }),
      },
    });
    expect(events.at(-1)).toEqual({ type: 'routing', state: null });
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

    // One line of presence, replaced as the bot moves on: started, thinking,
    // each tool in turn (thinking between them), then gone before the answer.
    expect(routing.map((state) => state.activity?.label)).toEqual([
      'Getting started…',
      'Wait, let me think…',
      'Reading launch-brief.md…',
      'Thinking it over…',
      'Running npm run test:fast…',
      'Thinking it over…',
      undefined,
    ]);
    expect(routing.every((state) => state.target === 'Forge')).toBe(true);
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

  it('tells a chained teammate what was attached, since it only sees relay text', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: bot === 'forge' ? '@sable over to you' : 'got it' }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const image: PromptImage = { data: 'aGk=', mimeType: 'image/png' };

    await service.send(group.id, '@forge look at this', {
      images: [image],
      files: [{ name: 'brief.md', mimeType: 'text/markdown', data: 'aGk=' }],
    });

    const sable = gatewayFor(adapter, 'sable');
    // The relay text says what came with the message, so a teammate that was not
    // addressed is not answering a message whose picture it was never told about.
    expect(sable.prompts[0]).toContain('[attached: 1 image, 1 file]');
    // The image is part of the human message, so it reaches every prompt in the round.
    expect(sable.imagesSent[0]).toEqual([image]);
  });

  it('group explicit mentions answer in order, each seeing prior replies', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    await service.send(group.id, '@sable @forge go');

    // The first prompt of a discussion introduces the room, because a bot can only
    // address a teammate by handle and has no other way to learn it.
    expect(gatewayFor(adapter, 'sable').prompts).toEqual([
      `${room}\n\n[Launch] You: @sable @forge go`,
    ]);
    // Forge is second, so it also gets what Sable just said.
    expect(gatewayFor(adapter, 'forge').prompts).toEqual([
      `${room}\n\n[Launch] You: @sable @forge go\n\n[Launch] Sable: sable here`,
    ]);
    const entries = service.transcript(group.id);
    expect(entries.map((entry) => entry.author)).toEqual([
      { role: 'user' },
      { role: 'bot', name: 'Sable', username: 'sable' },
      { role: 'bot', name: 'Forge', username: 'forge' },
    ]);
  });

  it('@all answers every member sequentially', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    await service.send(group.id, '@all standup');

    expect(gatewayFor(adapter, 'forge').prompts).toEqual([`${room}\n\n[Launch] You: @all standup`]);
    expect(gatewayFor(adapter, 'sable').prompts).toEqual([
      `${room}\n\n[Launch] You: @all standup\n\n[Launch] Forge: forge here`,
    ]);
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

  it('catches a bot up on the rounds it sat out, and never repeats itself', async () => {
    const { adapter, service } = harness({
      script: ({ bot, call }) => ({ text: `${bot} reply ${call}` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    // Round one: only Forge is asked.
    await service.send(group.id, '@forge first');
    // Round two: only Sable. It has never been prompted, so it is handed the whole
    // discussion — including the reply that was relayed to nobody else.
    await service.send(group.id, '@sable second');
    const sable = gatewayFor(adapter, 'sable');
    expect(sable.prompts[0]).toBe(
      `${room}\n\n[Launch] You: @forge first\n\n[Launch] Forge: forge reply 1\n\n` +
        '[Launch] You: @sable second',
    );

    // Round three: Forge again. It already knows what it said itself, so its own
    // words are not repeated back to it as though someone else had said them.
    await service.send(group.id, '@forge third');
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
    // A group answers when it is addressed (or has a lead), so each line names it.
    await service.send(launch.id, '@forge hello in launch');
    await service.send(research.id, '@forge hello in research');

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
    service.newDiscussion('dm-forge');
    await service.send('dm-forge', 'new line');

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
    await service.dispose();

    // A second host opening the same data dir continues where the first left.
    const again = serviceOn(root, adapter);
    registerService(again);
    await again.send(group.id, '@sable and now');
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

  it('unaddressed group message routes to the lead', async () => {
    const { adapter, service } = harness();
    await twoBots(service);
    const group = service.createGroup({
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
    });

    await service.send(group.id, 'what next');

    expect(gatewayFor(adapter, 'forge').prompts).toEqual([
      'You are the lead of the group "Launch". Answer or @mention the teammate who should answer.\n\n' +
        `${room}\n\n[Launch] You: what next`,
    ]);
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
  });

  it('no lead means silence', async () => {
    const { adapter, service } = harness();
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.send(group.id, 'hello?');

    expect(service.transcript(group.id).map((entry) => entry.author)).toEqual([{ role: 'user' }]);
    expect(events.filter((event) => event.type === 'routing')).toEqual([]);
    expect(factoryFor(adapter, 'forge').gateways).toHaveLength(0);
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
  });

  it('chain stops at the cap and records a capped note', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: bot === 'forge' ? '@sable ping' : '@forge pong' }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'], chainCap: 2 });

    await service.send(group.id, '@forge go');

    const entries = service.transcript(group.id);
    expect(entries.filter((entry) => entry.author.role === 'bot')).toHaveLength(3);
    const notes = entries
      .filter((entry) => entry.author.role === 'system')
      .map((entry) => entry.text);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('Chain capped after 2 hops');
    expect(gatewayFor(adapter, 'forge').prompts).toHaveLength(2);
    expect(gatewayFor(adapter, 'sable').prompts).toHaveLength(1);
  });

  it('unknown and self mentions are ignored with a note', async () => {
    const { adapter, service } = harness({
      script: () => ({ text: '@forge @nobody hello' }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });

    await service.send(group.id, '@forge go');

    const notes = service
      .transcript(group.id)
      .filter((entry) => entry.author.role === 'system')
      .map((entry) => entry.text);
    expect(notes).toEqual([
      'Ignored mention of @forge: a bot does not relay to itself.',
      'Ignored mention of @nobody: not a member of this conversation.',
    ]);
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
  });

  it('send during a round is refused with a system note', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'late', hold: true }) });
    await service.createBot(botInput());
    const first = service.send('dm-forge', 'hi');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;

    const second = service.send('dm-forge', 'again');

    await expect(second).rejects.toThrow('A round is already running in this conversation.');
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'system' },
      text: 'A round is already running in this conversation.',
    });
    gateway.release();
    await first;
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'late',
    });
  });

  it('stop aborts and clears the queue', async () => {
    const { adapter, service } = harness({
      script: () => ({ text: '@sable take over', hold: true }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));
    const first = service.send(group.id, '@forge go');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;

    service.stop(group.id);
    await first;

    expect(gateway.aborted).toBe(true);
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
    expect(service.transcript(group.id).map((entry) => entry.author)).toEqual([
      { role: 'user' },
      { role: 'system' },
    ]);
    expect(service.transcript(group.id).at(-1)).toMatchObject({ text: 'Stopped.' });
    // The round's own teardown is the only place the routing state is cleared.
    expect(events.filter((event) => event.type === 'routing' && event.state === null)).toHaveLength(
      1,
    );
  });

  it('stop settles a turn whose engine never reports run-end', async () => {
    const { adapter, service } = harness({
      script: ({ call }) => (call === 1 ? { hold: true, abortSilently: true } : { text: 'ok' }),
    });
    await service.createBot(botInput());
    const first = service.send('dm-forge', 'hi');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;

    service.stop('dm-forge');

    // The abort resolved without a run-end; the round still has to settle,
    // otherwise every later send is refused forever.
    await expect(first).resolves.toBeUndefined();
    expect(gateway.aborted).toBe(true);
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'system' },
      text: 'Stopped.',
    });

    await service.send('dm-forge', 'again');
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'ok',
    });
  });
});

describe('BotService sessions', () => {
  it('resume reuses stored engine session ids', async () => {
    const { root, service } = harness({ script: () => ({ text: 'ok' }) });
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    const stored = loadBotRegistry(root).conversations[0]?.sessions['forge']?.engineSessionId;
    expect(stored).toBe('forge-session-1');

    await service.dispose();

    const restartedAdapter = new FakeAdapter(() => ({ text: 'again' }), {
      script: () => ({ text: 'again' }),
    });
    const restarted = serviceOn(root, restartedAdapter);
    registerService(restarted);
    await restarted.send('dm-forge', 'again');

    const resumed = factoryFor(restartedAdapter, 'forge');
    expect(resumed.createCalls).toHaveLength(1);
    expect(resumed.createCalls[0]?.sessionId).toBe(stored);
  });

  it('two bots on one engine kind get independent gateways', async () => {
    const { root, adapter, service } = harness();
    await twoBots(service);

    await service.send('dm-forge', 'hi');
    await service.send('dm-sable', 'hi');

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
    await service.send('dm-forge', 'again');

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

  it('newDiscussion starts fresh sessions', async () => {
    const { root, adapter, service } = harness();
    await service.createBot(botInput());
    await service.send('dm-forge', 'hi');
    const before = loadBotRegistry(root).conversations[0]?.sessions['forge']?.engineSessionId;

    service.newDiscussion('dm-forge');
    await service.send('dm-forge', 'again');

    const factory = factoryFor(adapter, 'forge');
    expect(factory.createCalls).toHaveLength(2);
    expect(factory.createCalls[1]?.sessionId).toBeUndefined();
    expect(factory.gateways[0]?.disposed).toBe(true);
    const after = loadBotRegistry(root).conversations[0]?.sessions['forge']?.engineSessionId;
    expect(after).not.toBe(before);
    expect(after).toBe('forge-session-2');
  });

  it('newDiscussion during a queued round stops the round', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) =>
        bot === 'forge' ? { text: '@sable take over', hold: true } : { text: 'Sable here' },
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
    const first = service.send(group.id, '@forge go');
    const forge = gatewayFor(adapter, 'forge');
    await forge.prompted;

    service.newDiscussion(group.id);
    await first;

    // The queued relay must not be delivered on the sessions just abandoned.
    expect(factoryFor(adapter, 'sable').gateways).toHaveLength(0);
    expect(forge.prompts).toHaveLength(1);
    expect(forge.disposed).toBe(true);
    // The boundary is a divider in the same transcript, so one chat reads as the
    // sequence of engine sessions it is.
    expect(service.transcript(group.id).map((entry) => entry.author)).toEqual([
      { role: 'user' },
      { role: 'discussion' },
    ]);
    expect(service.transcript(group.id).map((entry) => entry.text)).toEqual([
      '@forge go',
      'New discussion',
    ]);
  });

  it('keeps a conversation across a restart, and marks a new discussion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morse-bot-restart-'));
    const first = serviceOn(dir, new FakeAdapter(() => ({ text: 'Done.' })));
    registerService(first);
    await first.createBot(botInput());
    await first.send('dm-forge', 'hi');
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
    const gateway = gatewayFor(adapter, 'forge');
    expect(service.roster().bots[0]?.warm).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(gateway.disposed).toBe(false);

    await service.send('dm-forge', 'again');
    await vi.advanceTimersByTimeAsync(999);
    expect(gateway.disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.disposed).toBe(true);
    expect(service.roster().bots[0]?.warm).toBe(false);
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
    const pending = service.send('dm-forge', 'hi');
    const gateway = gatewayFor(adapter, 'forge');
    await gateway.prompted;

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(
      service
        .transcript('dm-forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual(['Turn timed out after 1s']);
    expect(gateway.disposed).toBe(true);
    expect(service.roster().bots[0]?.warm).toBe(false);

    await service.send('dm-forge', 'again');
    expect(service.transcript('dm-forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'ok',
    });
  });

  it('gateway creation that never answers is bounded', async () => {
    vi.useFakeTimers();
    const { adapter, service } = harness({ turnTimeoutMs: 1_000, hangFirstCreate: true });
    await service.createBot(botInput());

    const pending = service.send('dm-forge', 'hi');
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(
      service
        .transcript('dm-forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual(['Forge could not start: gateway creation timed out after 1s']);
    expect(factoryFor(adapter, 'forge').createCalls).toHaveLength(1);

    await service.send('dm-forge', 'again');
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
