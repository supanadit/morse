import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
import type { BotCreateInput } from '@morse/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../logger.js';
import type { BotEngineAdapter, BotEvent } from './service.js';
import { BotService } from './service.js';
import { loadBotRegistry, readBotIdentity } from './store.js';
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
  script: Script;
}

/** One gateway a fake factory handed out, with everything a test can observe. */
class FakeGateway implements AgentGateway {
  readonly kind = 'fake';
  readonly prompts: string[] = [];
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

  prompt(text: string): Promise<PromptDisposition> {
    this.prompts.push(text);
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
  probeDefaults?: (options: { workspace: WorkspaceRef }) => Promise<AgentGateway>;
  private next = 0;

  constructor(
    readonly botRoot: string,
    readonly script: Script,
    readonly models: ModelRef[],
    private readonly options: FactoryOptions,
  ) {
    if (options.probeDefaults !== false) {
      this.probeDefaults = (input) => this.probe(input.workspace);
    }
  }

  get botName(): string {
    return basename(this.botRoot);
  }

  get workspace(): WorkspaceRef {
    return { cwd: join(this.botRoot, 'workspace'), name: this.botName };
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

class FakeAdapter implements BotEngineAdapter {
  readonly kind = 'fake';
  readonly capabilities: BotEngineCapabilities;
  readonly factories: FakeFactory[] = [];
  readonly credentialWrites: {
    botRoot: string;
    entries: { provider: string; apiKey: string }[];
  }[] = [];
  readonly subagentWrites: {
    botRoot: string;
    subagents: { name: string; prompt: string }[];
  }[] = [];
  readonly envs: NodeJS.ProcessEnv[] = [];
  /** Present unless the harness says the engine has no subagent writer. */
  writeSubagents:
    | ((botRoot: string, subagents: { name: string; prompt: string }[]) => void)
    | undefined;

  constructor(
    private readonly script: Script = () => ({}),
    private readonly options: FactoryOptions = { script },
  ) {
    this.capabilities = {
      supportsSubagents: options.supportsSubagents === true,
      supportsThinkingLevels: true,
      credentials: 'stored',
    };
    if (options.omitSubagentWriter !== true) {
      this.writeSubagents = (botRoot, subagents) => {
        this.subagentWrites.push({ botRoot, subagents });
      };
    }
  }

  createFactory(botRoot: string, env: NodeJS.ProcessEnv): AgentGatewayFactory {
    this.envs.push(env);
    const factory = new FakeFactory(botRoot, this.script, this.options.models ?? [], this.options);
    this.factories.push(factory);
    return factory;
  }

  writeCredentials(botRoot: string, entries: { provider: string; apiKey: string }[]): void {
    this.credentialWrites.push({ botRoot, entries });
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

function botInput(overrides: Partial<BotCreateInput> = {}): BotCreateInput {
  return {
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
  await service.createBot(botInput({ name: 'Sable', description: 'Reviews things' }));
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

    const botRoot = join(root, 'Forge');
    for (const dir of ['config', 'sessions', 'workspace']) {
      expect(existsSync(join(botRoot, dir))).toBe(true);
    }
    const identity: BotRecord = {
      name: 'Forge',
      description: 'Builds things',
      avatar: 'anvil.png',
      engineKind: 'fake',
      model: MODEL,
      thinkingLevel: 'medium',
      persona: 'You are Forge, the builder.',
      credentialEnv: ['ANTHROPIC_API_KEY'],
    };
    expect(readBotIdentity(botRoot)).toEqual(identity);
    expect(readFileSync(join(botRoot, 'workspace', 'AGENTS.md'), 'utf8')).toBe(
      '# Forge workspace\n',
    );
    expect(adapter.credentialWrites).toEqual([{ botRoot, entries: input.credentials }]);

    const factory = factoryFor(adapter, 'Forge');
    expect(factory.probeCalls).toBe(1);
    expect(factory.probed[0]?.disposed).toBe(true);
    expect(factory.gateways).toHaveLength(0);

    expect(service.roster()).toEqual({
      bots: [
        {
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
          id: 'dm-Forge',
          kind: 'dm',
          title: 'Forge',
          members: ['Forge'],
          chainCap: 8,
          updatedAt: expect.any(Number) as number,
        },
      ],
    });
  });

  it('createBot removes a half-written bot on probe failure', async () => {
    const { root, service } = harness({ probeThrows: true });

    await expect(service.createBot(botInput())).rejects.toThrow('probe failed');

    expect(existsSync(join(root, 'Forge'))).toBe(false);
    expect(service.roster()).toEqual({ bots: [], conversations: [] });
  });

  it('createBot refuses a name that would escape the bot root', async () => {
    const { service } = harness();

    await expect(service.createBot(botInput({ name: '../escape' }))).rejects.toThrow(
      'not a usable bot name',
    );

    expect(service.roster().bots).toHaveLength(0);
  });

  it('createBot refuses a name that differs only in case', async () => {
    const mixed = harness();
    await mixed.service.createBot(botInput({ name: 'Forge' }));

    await expect(mixed.service.createBot(botInput({ name: 'forge' }))).rejects.toThrow(
      /case-insensitive/,
    );

    expect(mixed.service.roster().bots.map((bot) => bot.name)).toEqual(['Forge']);
    expect(existsSync(join(mixed.root, 'forge'))).toBe(false);

    // The lowercase name on its own is still a fine bot name.
    const lower = harness();
    await lower.service.createBot(botInput({ name: 'forge' }));
    expect(lower.service.roster().bots.map((bot) => bot.name)).toEqual(['forge']);
  });

  it('createGroup lists the group with its members, lead and chain cap', async () => {
    const { service } = harness();
    await twoBots(service);

    const group = service.createGroup({
      name: 'Launch',
      members: ['Forge', 'Sable'],
      lead: 'Forge',
      chainCap: 3,
    });

    expect(group).toEqual({
      id: expect.stringMatching(/^grp-launch-[0-9a-f]{4}$/) as string,
      kind: 'group',
      title: 'Launch',
      members: ['Forge', 'Sable'],
      lead: 'Forge',
      chainCap: 3,
      updatedAt: expect.any(Number) as number,
    });
    expect(service.roster().conversations).toContainEqual(group);
  });
});

describe('BotService subagents', () => {
  const SUBAGENTS = [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }];

  it('hands a subagent-capable adapter the wizard rows and keeps them on the record', async () => {
    const { root, adapter, service } = harness({ supportsSubagents: true });

    await service.createBot(botInput({ subagents: SUBAGENTS, agentsMd: '# Forge workspace\n' }));

    const botRoot = join(root, 'Forge');
    expect(adapter.subagentWrites).toEqual([{ botRoot, subagents: SUBAGENTS }]);
    // The rows travel with the bot's identity, so a copied directory keeps them.
    expect(readBotIdentity(botRoot)?.subagents).toEqual(SUBAGENTS);
    // They are engine config now, not prose folded into the workspace document.
    expect(readFileSync(join(botRoot, 'workspace', 'AGENTS.md'), 'utf8')).toBe(
      '# Forge workspace\n',
    );
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

  it('skips the writer when the wizard sent no rows', async () => {
    const { adapter, service } = harness({ supportsSubagents: true });

    await service.createBot(botInput());
    await service.createBot(botInput({ name: 'Sable', subagents: [] }));

    expect(adapter.subagentWrites).toEqual([]);
  });

  it('rolls the whole bot back when a subagent name is not usable', async () => {
    const { root, adapter, service } = harness({ supportsSubagents: true });

    await expect(
      service.createBot(botInput({ subagents: [{ name: '../escape', prompt: 'Anything.' }] })),
    ).rejects.toThrow('not a usable subagent name');

    expect(existsSync(join(root, 'Forge'))).toBe(false);
    expect(adapter.subagentWrites).toEqual([]);
    expect(service.roster().bots).toHaveLength(0);
  });
});

describe('BotService rounds', () => {
  it('dm send relays and records the reply', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'Done.' }) });
    await service.createBot(botInput());
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.send('dm-Forge', 'hi');

    expect(gatewayFor(adapter, 'Forge').prompts).toEqual(['[Forge] You: hi']);
    const entries = service.transcript('dm-Forge');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ author: { role: 'user' }, text: 'hi' });
    expect(entries[1]).toMatchObject({ author: { role: 'bot', name: 'Forge' }, text: 'Done.' });
    expect(service.open('dm-Forge')).toEqual(entries);
    expect(events).toContainEqual({
      type: 'transcript',
      conversationId: 'dm-Forge',
      entries: [expect.objectContaining({ text: 'hi' })],
      replace: false,
    });
    expect(events).toContainEqual({
      type: 'routing',
      state: { conversationId: 'dm-Forge', target: 'Forge', queued: [] },
    });
    expect(events.at(-1)).toEqual({ type: 'routing', state: null });
  });

  it('group explicit mentions answer in order, each seeing prior replies', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['Forge', 'Sable'] });

    await service.send(group.id, '@Sable @Forge go');

    expect(gatewayFor(adapter, 'Sable').prompts).toEqual(['[Launch] You: @Sable @Forge go']);
    expect(gatewayFor(adapter, 'Forge').prompts).toEqual([
      '[Launch] You: @Sable @Forge go\n\n[Launch] Sable: Sable here',
    ]);
    const entries = service.transcript(group.id);
    expect(entries.map((entry) => entry.author)).toEqual([
      { role: 'user' },
      { role: 'bot', name: 'Sable' },
      { role: 'bot', name: 'Forge' },
    ]);
  });

  it('@all answers every member sequentially', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: `${bot} here` }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['Forge', 'Sable'] });

    await service.send(group.id, '@all standup');

    expect(gatewayFor(adapter, 'Forge').prompts).toEqual(['[Launch] You: @all standup']);
    expect(gatewayFor(adapter, 'Sable').prompts).toEqual([
      '[Launch] You: @all standup\n\n[Launch] Forge: Forge here',
    ]);
    expect(
      service
        .transcript(group.id)
        .filter((entry) => entry.author.role === 'bot')
        .map((entry) => entry.author),
    ).toEqual([
      { role: 'bot', name: 'Forge' },
      { role: 'bot', name: 'Sable' },
    ]);
  });

  it('unaddressed group message routes to the lead', async () => {
    const { adapter, service } = harness();
    await twoBots(service);
    const group = service.createGroup({
      name: 'Launch',
      members: ['Forge', 'Sable'],
      lead: 'Forge',
    });

    await service.send(group.id, 'what next');

    expect(gatewayFor(adapter, 'Forge').prompts).toEqual([
      'You are the lead of the group "Launch". Answer or @mention the teammate who should answer.\n\n' +
        '[Launch] You: what next',
    ]);
    expect(factoryFor(adapter, 'Sable').gateways).toHaveLength(0);
  });

  it('no lead means silence', async () => {
    const { adapter, service } = harness();
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['Forge', 'Sable'] });
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.send(group.id, 'hello?');

    expect(service.transcript(group.id).map((entry) => entry.author)).toEqual([{ role: 'user' }]);
    expect(events.filter((event) => event.type === 'routing')).toEqual([]);
    expect(factoryFor(adapter, 'Forge').gateways).toHaveLength(0);
    expect(factoryFor(adapter, 'Sable').gateways).toHaveLength(0);
  });

  it('chain stops at the cap and records a capped note', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) => ({ text: bot === 'Forge' ? '@Sable ping' : '@Forge pong' }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['Forge', 'Sable'], chainCap: 2 });

    await service.send(group.id, '@Forge go');

    const entries = service.transcript(group.id);
    expect(entries.filter((entry) => entry.author.role === 'bot')).toHaveLength(3);
    const notes = entries
      .filter((entry) => entry.author.role === 'system')
      .map((entry) => entry.text);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('Chain capped after 2 hops');
    expect(gatewayFor(adapter, 'Forge').prompts).toHaveLength(2);
    expect(gatewayFor(adapter, 'Sable').prompts).toHaveLength(1);
  });

  it('unknown and self mentions are ignored with a note', async () => {
    const { adapter, service } = harness({
      script: () => ({ text: '@Forge @nobody hello' }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['Forge', 'Sable'] });

    await service.send(group.id, '@Forge go');

    const notes = service
      .transcript(group.id)
      .filter((entry) => entry.author.role === 'system')
      .map((entry) => entry.text);
    expect(notes).toEqual([
      'Ignored mention of @Forge: a bot does not relay to itself.',
      'Ignored mention of @nobody: not a member of this conversation.',
    ]);
    expect(factoryFor(adapter, 'Sable').gateways).toHaveLength(0);
  });

  it('send during a round is refused with a system note', async () => {
    const { adapter, service } = harness({ script: () => ({ text: 'late', hold: true }) });
    await service.createBot(botInput());
    const first = service.send('dm-Forge', 'hi');
    const gateway = gatewayFor(adapter, 'Forge');
    await gateway.prompted;

    const second = service.send('dm-Forge', 'again');

    await expect(second).rejects.toThrow('A round is already running in this conversation.');
    expect(service.transcript('dm-Forge').at(-1)).toMatchObject({
      author: { role: 'system' },
      text: 'A round is already running in this conversation.',
    });
    gateway.release();
    await first;
    expect(service.transcript('dm-Forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'late',
    });
  });

  it('stop aborts and clears the queue', async () => {
    const { adapter, service } = harness({
      script: () => ({ text: '@Sable take over', hold: true }),
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['Forge', 'Sable'] });
    const events: BotEvent[] = [];
    service.subscribe((event) => events.push(event));
    const first = service.send(group.id, '@Forge go');
    const gateway = gatewayFor(adapter, 'Forge');
    await gateway.prompted;

    service.stop(group.id);
    await first;

    expect(gateway.aborted).toBe(true);
    expect(factoryFor(adapter, 'Sable').gateways).toHaveLength(0);
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
    const first = service.send('dm-Forge', 'hi');
    const gateway = gatewayFor(adapter, 'Forge');
    await gateway.prompted;

    service.stop('dm-Forge');

    // The abort resolved without a run-end; the round still has to settle,
    // otherwise every later send is refused forever.
    await expect(first).resolves.toBeUndefined();
    expect(gateway.aborted).toBe(true);
    expect(service.transcript('dm-Forge').at(-1)).toMatchObject({
      author: { role: 'system' },
      text: 'Stopped.',
    });

    await service.send('dm-Forge', 'again');
    expect(service.transcript('dm-Forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'ok',
    });
  });
});

describe('BotService sessions', () => {
  it('resume reuses stored engine session ids', async () => {
    const { root, service } = harness({ script: () => ({ text: 'ok' }) });
    await service.createBot(botInput());
    await service.send('dm-Forge', 'hi');
    const stored = loadBotRegistry(root).conversations[0]?.sessions['Forge']?.engineSessionId;
    expect(stored).toBe('Forge-session-1');

    await service.dispose();

    const restartedAdapter = new FakeAdapter(() => ({ text: 'again' }), {
      script: () => ({ text: 'again' }),
    });
    const restarted = serviceOn(root, restartedAdapter);
    registerService(restarted);
    await restarted.send('dm-Forge', 'again');

    const resumed = factoryFor(restartedAdapter, 'Forge');
    expect(resumed.createCalls).toHaveLength(1);
    expect(resumed.createCalls[0]?.sessionId).toBe(stored);
  });

  it('two bots on one engine kind get independent gateways', async () => {
    const { root, adapter, service } = harness();
    await twoBots(service);

    await service.send('dm-Forge', 'hi');
    await service.send('dm-Sable', 'hi');

    const forge = factoryFor(adapter, 'Forge');
    const sable = factoryFor(adapter, 'Sable');
    expect(forge).not.toBe(sable);
    expect(forge.botRoot).toBe(join(root, 'Forge'));
    expect(sable.botRoot).toBe(join(root, 'Sable'));
    expect(forge.gateways[0]).not.toBe(sable.gateways[0]);
    expect(forge.gateways[0]?.prompts).toEqual(['[Forge] You: hi']);
    expect(sable.gateways[0]?.prompts).toEqual(['[Sable] You: hi']);
  });

  it("fresh session's first prompt carries the persona prefix", async () => {
    const { adapter, service } = harness();
    await service.createBot(botInput({ persona: 'You are Forge, the builder.' }));

    await service.send('dm-Forge', 'hi');
    await service.send('dm-Forge', 'again');

    expect(gatewayFor(adapter, 'Forge').prompts).toEqual([
      'You are Forge, the builder.\n\n---\n\n[Forge] You: hi',
      '[Forge] You: again',
    ]);
  });

  it('newDiscussion starts fresh sessions', async () => {
    const { root, adapter, service } = harness();
    await service.createBot(botInput());
    await service.send('dm-Forge', 'hi');
    const before = loadBotRegistry(root).conversations[0]?.sessions['Forge']?.engineSessionId;

    service.newDiscussion('dm-Forge');
    await service.send('dm-Forge', 'again');

    const factory = factoryFor(adapter, 'Forge');
    expect(factory.createCalls).toHaveLength(2);
    expect(factory.createCalls[1]?.sessionId).toBeUndefined();
    expect(factory.gateways[0]?.disposed).toBe(true);
    const after = loadBotRegistry(root).conversations[0]?.sessions['Forge']?.engineSessionId;
    expect(after).not.toBe(before);
    expect(after).toBe('Forge-session-2');
  });

  it('newDiscussion during a queued round stops the round', async () => {
    const { adapter, service } = harness({
      script: ({ bot }) =>
        bot === 'Forge' ? { text: '@Sable take over', hold: true } : { text: 'Sable here' },
    });
    await twoBots(service);
    const group = service.createGroup({ name: 'Launch', members: ['Forge', 'Sable'] });
    const first = service.send(group.id, '@Forge go');
    const forge = gatewayFor(adapter, 'Forge');
    await forge.prompted;

    service.newDiscussion(group.id);
    await first;

    // The queued relay must not be delivered on the sessions just abandoned.
    expect(factoryFor(adapter, 'Sable').gateways).toHaveLength(0);
    expect(forge.prompts).toHaveLength(1);
    expect(forge.disposed).toBe(true);
    expect(service.transcript(group.id).map((entry) => entry.text)).toEqual([
      '@Forge go',
      'New discussion started.',
    ]);
  });

  it('idle gateway is disposed after idleMs', async () => {
    vi.useFakeTimers();
    const { adapter, service } = harness({ idleMs: 1_000 });
    await service.createBot(botInput());

    await service.send('dm-Forge', 'hi');
    const gateway = gatewayFor(adapter, 'Forge');
    expect(service.roster().bots[0]?.warm).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(gateway.disposed).toBe(false);

    await service.send('dm-Forge', 'again');
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
    const pending = service.send('dm-Forge', 'hi');
    const gateway = gatewayFor(adapter, 'Forge');
    await gateway.prompted;

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(
      service
        .transcript('dm-Forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual(['Turn timed out after 1s']);
    expect(gateway.disposed).toBe(true);
    expect(service.roster().bots[0]?.warm).toBe(false);

    await service.send('dm-Forge', 'again');
    expect(service.transcript('dm-Forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'ok',
    });
  });

  it('gateway creation that never answers is bounded', async () => {
    vi.useFakeTimers();
    const { adapter, service } = harness({ turnTimeoutMs: 1_000, hangFirstCreate: true });
    await service.createBot(botInput());

    const pending = service.send('dm-Forge', 'hi');
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(
      service
        .transcript('dm-Forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual(['Forge could not start: gateway creation timed out after 1s']);
    expect(factoryFor(adapter, 'Forge').createCalls).toHaveLength(1);

    await service.send('dm-Forge', 'again');
    expect(factoryFor(adapter, 'Forge').createCalls).toHaveLength(2);
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
      { requestId: 'r4', kind: 'editor', title: 'Edit the notes' },
      { requestId: 'r5', kind: 'form', title: 'Settings', fields: [] },
    ];
    const { adapter, service } = harness({
      script: () => ({ interactions: requests, text: 'All done.' }),
    });
    await service.createBot(botInput());

    await service.send('dm-Forge', 'go');

    const gateway = gatewayFor(adapter, 'Forge');
    expect(gateway.responses).toEqual([
      { requestId: 'r1', confirmed: true },
      { requestId: 'r2', value: 'fast' },
      { requestId: 'r3', value: '' },
      { requestId: 'r4', cancelled: true },
      { requestId: 'r5', cancelled: true },
    ]);
    expect(
      service
        .transcript('dm-Forge')
        .filter((entry) => entry.author.role === 'system')
        .map((entry) => entry.text),
    ).toEqual([
      'Auto-answered: confirmed "Allow the tool?"',
      'Auto-answered: selected the first option of "Pick a model"',
      'Auto-answered: left "Name the release" blank',
      'Auto-answered: cancelled "Edit the notes"',
      'Auto-answered: cancelled "Settings"',
    ]);
    expect(service.transcript('dm-Forge').at(-1)).toMatchObject({
      author: { role: 'bot', name: 'Forge' },
      text: 'All done.',
    });
  });
});

describe('BotService model probes', () => {
  it('probeModels uses probeDefaults when the factory offers one', async () => {
    const { root, adapter, service } = harness({ models: [MODEL] });

    const models = await service.probeModels('fake', ['ANTHROPIC_API_KEY']);

    expect(models).toEqual([MODEL]);
    const factory = adapter.factories[0];
    expect(factory?.probeCalls).toBe(1);
    expect(factory?.createCalls).toHaveLength(0);
    expect(factory?.probed[0]?.disposed).toBe(true);
    expect(factory?.botRoot.startsWith(join(root, '.probe-'))).toBe(true);
    expect(readdirSync(root).some((name) => name.startsWith('.probe-'))).toBe(false);
  });

  it('probeModels falls back to create, state and dispose without probeDefaults', async () => {
    const { root, adapter, service } = harness({
      models: [MODEL],
      probeDefaults: false,
    });

    const models = await service.probeModels('fake', []);

    expect(models).toEqual([MODEL]);
    const factory = adapter.factories[0];
    expect(factory?.probeCalls).toBe(0);
    expect(factory?.createCalls).toHaveLength(1);
    expect(factory?.gateways[0]?.disposed).toBe(true);
    expect(readdirSync(root).some((name) => name.startsWith('.probe-'))).toBe(false);
  });
});
