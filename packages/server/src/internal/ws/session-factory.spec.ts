import { describe, expect, it, vi } from 'vitest';
import {
  SessionTranscriptStore,
  UnsupportedByHostError,
  silentLogger,
  type AgentExtras,
  type BotEvent,
  type BotService,
  type SessionRegistry,
} from '@morse/system';
import type { HostToClientMessage } from '@morse/protocol';
import type { WebSocket } from 'ws';
import { MorseSessionFactory } from './session-factory.service.js';
import { isLoopback, resolveMcpExtras, resolvePromptExtras } from './session-factory.service.js';
import { MorseGateway } from './morse.gateway.js';
import type { MorseServerConfig } from '../../app/config.js';

const WORKSPACE = { cwd: '/tmp/morse-bot-factory', name: 'morse-bot-factory' };
const CONFIG = {
  dataDir: '/tmp/morse-bot-factory/data',
  workspace: WORKSPACE,
  updateCheck: false,
  selfUpdate: false,
} as unknown as MorseServerConfig;

type FactoryArgs = ConstructorParameters<typeof MorseSessionFactory>;

/** A bot service a test drives by hand: its listeners are the whole host fan-out. */
function fakeBot() {
  const listeners = new Set<(event: BotEvent) => void>();
  const unsubscribe = vi.fn();
  const roster = { bots: [], conversations: [] };
  const group = {
    id: 'group-1',
    kind: 'group' as const,
    title: 'reviewers',
    members: ['forge', 'sentinel'],
    chainCap: 4,
    updatedAt: 1,
  };
  const service = {
    subscribe: vi.fn((listener: (event: BotEvent) => void) => {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    }),
    roster: vi.fn(() => roster),
    createBot: vi.fn(async () => undefined),
    deleteBot: vi.fn(async () => undefined),
    createGroup: vi.fn(() => group),
    updateGroup: vi.fn(() => group),
    deleteGroup: vi.fn(async () => undefined),
    probeModels: vi.fn(async () => [{ provider: 'pi', id: 'm', name: 'M' }]),
    open: vi.fn(() => ({
      entries: [{ id: 'line-1', author: { role: 'system' }, text: 'hello', at: 2 }],
      hasMore: false,
    })),
    history: vi.fn(() => ({ entries: [], hasMore: false })),
    send: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    newDiscussion: vi.fn(),
  };
  return {
    service: service as unknown as BotService,
    roster,
    group,
    calls: service,
    listeners,
    subscribe: service.subscribe,
    unsubscribe,
    /** Plays one bot event as the shared service would fan it out. */
    emit(event: BotEvent): void {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

/** The factory over inert doubles: only the bot wiring is under test here. */
function factoryWith(bot: BotService | undefined): MorseSessionFactory {
  const registry = {
    subscribe: () => () => undefined,
    onRemoval: () => () => undefined,
    activeKeyOf: () => undefined,
    hotKeys: () => [],
    stateOf: () => undefined,
    defaultWorkspace: WORKSPACE,
    draftDefaults: async () => undefined,
    listSessions: async () => [],
    sessionCounts: async () => [] as [string, number][],
    listProjects: async () => [],
    searchSessions: async () => [],
    dispose: async () => undefined,
  } as unknown as SessionRegistry;
  const router = {
    defaultExtras: () => undefined,
    engineOptions: () => [],
    extrasFor: () => undefined,
    agentFor: () => undefined,
    dispose: async () => undefined,
  } as unknown as FactoryArgs[6];
  return new MorseSessionFactory(
    registry,
    new SessionTranscriptStore(),
    {} as FactoryArgs[2],
    silentLogger,
    CONFIG,
    {} as FactoryArgs[5],
    router as FactoryArgs[6],
    {} as FactoryArgs[7],
    bot,
  );
}

/** One connection's controller and everything it has emitted so far. */
function connect(factory: MorseSessionFactory): {
  controller: ReturnType<MorseSessionFactory['createFor']>;
  messages: HostToClientMessage[];
} {
  const messages: HostToClientMessage[] = [];
  return { controller: factory.createFor((message) => messages.push(message)), messages };
}

function fakeSocket(): WebSocket {
  return { readyState: 1, send: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

/**
 * The server host's half of bot mode: one shared `BotService`, `bot/*` requests
 * routed into it per connection, and its events fanned out to every socket that
 * is still connected. The extension host reports no `bot` capability yet, which
 * is why the flag is conditional and not a constant.
 */
describe('MorseSessionFactory bot wiring', () => {
  it('reports the bot capability only when the service resolved', () => {
    expect(factoryWith(fakeBot().service).capabilities().bot).toBe(true);
    expect(factoryWith(undefined).capabilities().bot).toBeUndefined();
  });

  it('answers bot/list with the roster', async () => {
    const bot = fakeBot();
    const { controller, messages } = connect(factoryWith(bot.service));

    await controller.handleClientMessage({ type: 'bot/list', payload: {} });

    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });
  });

  it('carries the reader’s attachments with the line', async () => {
    const bot = fakeBot();
    const { controller } = connect(factoryWith(bot.service));

    await controller.handleClientMessage({
      type: 'bot/send',
      payload: {
        conversationId: 'dm-x',
        text: 'what do you make of this?',
        images: [{ data: 'aGk=', mimeType: 'image/png' }],
        files: [{ name: 'cv.pdf', mimeType: 'application/pdf', data: 'aGk=' }],
      },
    });

    expect(bot.calls.send).toHaveBeenCalledWith('dm-x', 'what do you make of this?', {
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
      files: [{ name: 'cv.pdf', mimeType: 'application/pdf', data: 'aGk=' }],
    });
  });

  it('runs bot/send without awaiting it and forwards the transcript events', async () => {
    const bot = fakeBot();
    const { controller, messages } = connect(factoryWith(bot.service));

    await controller.handleClientMessage({
      type: 'bot/send',
      payload: { conversationId: 'dm-x', text: 'hi' },
    });
    // A line with nothing attached sends an empty attachment set, never a hole.
    expect(bot.calls.send).toHaveBeenCalledWith('dm-x', 'hi', {});

    bot.emit({
      type: 'transcript',
      conversationId: 'dm-x',
      entries: [{ id: 'line-2', author: { role: 'bot', name: 'forge' }, text: 'hey', at: 3 }],
      replace: false,
    });

    expect(messages.at(-1)).toEqual({
      type: 'bot/transcript',
      payload: {
        conversationId: 'dm-x',
        entries: [{ id: 'line-2', author: { role: 'bot', name: 'forge' }, text: 'hey', at: 3 }],
        replace: false,
      },
    });
  });

  it('echoes the probe request id and republishes the roster after a mutation', async () => {
    const bot = fakeBot();
    const { controller, messages } = connect(factoryWith(bot.service));

    await controller.handleClientMessage({
      type: 'bot/probeModels',
      payload: {
        kind: 'pi',
        envVars: ['KEY'],
        credentials: [{ provider: 'anthropic', apiKey: 'sk-test' }],
        requestId: 'req-9',
      },
    });
    expect(messages.at(-1)).toEqual({
      type: 'bot/models',
      payload: {
        requestId: 'req-9',
        kind: 'pi',
        models: [{ provider: 'pi', id: 'm', name: 'M' }],
      },
    });

    await controller.handleClientMessage({
      type: 'bot/create',
      payload: {
        name: 'forge',
        description: 'writes things',
        engineKind: 'pi',
        credentials: [{ provider: 'anthropic', apiKey: 'sk-test' }],
        envVars: [],
        persona: 'You build.',
        requestId: 'req-c',
      },
    });
    expect(bot.calls.createBot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'forge', engineKind: 'pi' }),
    );
    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });

    await controller.handleClientMessage({
      type: 'bot/groupCreate',
      payload: { name: 'reviewers', members: ['forge', 'sentinel'] },
    });
    expect(bot.calls.createGroup).toHaveBeenCalled();
    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });

    await controller.handleClientMessage({
      type: 'bot/groupUpdate',
      payload: { id: 'group-1', name: 'reviewers, revised', members: ['forge'] },
    });
    expect(bot.calls.updateGroup).toHaveBeenCalled();
    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });

    await controller.handleClientMessage({
      type: 'bot/groupDelete',
      payload: { id: 'group-1' },
    });
    expect(bot.calls.deleteGroup).toHaveBeenCalledWith('group-1');
    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });

    await controller.handleClientMessage({ type: 'bot/delete', payload: { name: 'forge' } });
    expect(bot.calls.deleteBot).toHaveBeenCalledWith('forge');
    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });
  });

  it('stops a round and starts a new discussion through the service', async () => {
    const bot = fakeBot();
    const { controller, messages } = connect(factoryWith(bot.service));

    await controller.handleClientMessage({
      type: 'bot/stop',
      payload: { conversationId: 'dm-x' },
    });
    expect(bot.calls.stop).toHaveBeenCalledWith('dm-x');
    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });

    await controller.handleClientMessage({
      type: 'bot/newDiscussion',
      payload: { conversationId: 'dm-x' },
    });
    expect(bot.calls.newDiscussion).toHaveBeenCalledWith('dm-x');
    expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });
  });

  it('opens a conversation as a replacing transcript', async () => {
    const bot = fakeBot();
    const { controller, messages } = connect(factoryWith(bot.service));

    await controller.handleClientMessage({
      type: 'bot/open',
      payload: { conversationId: 'dm-x' },
    });

    expect(messages.at(-1)).toEqual({
      type: 'bot/transcript',
      payload: {
        conversationId: 'dm-x',
        entries: [{ id: 'line-1', author: { role: 'system' }, text: 'hello', at: 2 }],
        replace: true,
        hasMore: false,
      },
    });
  });

  it('broadcasts routing state and forgets the feed when the socket disconnects', () => {
    const bot = fakeBot();
    const factory = factoryWith(bot.service);
    const gateway = new MorseGateway(factory, silentLogger);
    const socket = fakeSocket();

    gateway.handleConnection(socket);
    expect(bot.subscribe).toHaveBeenCalledTimes(1);

    bot.emit({ type: 'routing', state: { conversationId: 'dm-x', queued: [] } });
    const sent = (socket.send as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(JSON.parse(sent.at(-1)?.[0] ?? '{}')).toMatchObject({
      type: 'bot/routing',
      payload: { state: { conversationId: 'dm-x', queued: [] } },
    });

    gateway.handleDisconnect(socket);
    expect(bot.unsubscribe).toHaveBeenCalledTimes(1);
    expect(bot.listeners.size).toBe(0);
  });
});

/**
 * The per-engine MCP resolution: the rule that keeps pi's and OpenCode's
 * servers from mixing. A command naming an engine gets that engine's port, one
 * naming none gets the default's, and a named engine without administration is
 * a refusal — never another engine's config.
 */
describe('resolveMcpExtras', () => {
  const mcpOf = (label: string) => ({
    configSignature: async () => label,
    status: async () => label,
    add: async () => label,
    remove: async () => label,
    setEnabled: async () => label,
    trustProject: async () => label,
  });
  const routerFor = (engines: Record<string, AgentExtras | undefined>, fallback = 'pi') => ({
    extrasFor: (kind: string) => engines[kind]?.mcp === undefined ? undefined : engines[kind],
    defaultExtras: () => engines[fallback],
  });
  const pi = { mcp: mcpOf('pi') } as unknown as AgentExtras;
  const openCode = { mcp: mcpOf('opencode') } as unknown as AgentExtras;
  const router = routerFor({ pi, opencode: openCode });

  it('resolves the engine a command names', async () => {
    await expect(resolveMcpExtras(router, 'pi').status()).resolves.toBe('pi');
    await expect(resolveMcpExtras(router, 'opencode').status()).resolves.toBe('opencode');
  });

  it('falls back to the default engine when none is named', async () => {
    await expect(resolveMcpExtras(router, undefined).status()).resolves.toBe('pi');
    await expect(resolveMcpExtras(router, '').status()).resolves.toBe('pi');
    await expect(resolveMcpExtras(router, 42).status()).resolves.toBe('pi');
  });

  it('refuses an unknown kind instead of falling back to another engine', () => {
    expect(() => resolveMcpExtras(router, 'codex')).toThrow(UnsupportedByHostError);
    expect(() => resolveMcpExtras(router, 'codex')).toThrow(/codex engine has no MCP/);
  });

  it('refuses a default engine without administration', () => {
    const bare = routerFor({ opencode: openCode }, 'none');
    expect(() => resolveMcpExtras(bare, undefined)).toThrow(/no MCP administration/);
  });
});

/**
 * The gate on `updateHost`. A `--lan` Morse serves an unauthenticated UI, so an
 * address this function lets through is an address that may run `npm install -g`
 * on the host. Every case below is a real spelling a socket can hand over.
 */
describe('isLoopback', () => {
  it('accepts the loopback spellings a socket actually uses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.0.0.5')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    // A dual-stack listener maps IPv4 callers into IPv6.
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
  });

  it('refuses a LAN or public address', () => {
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('::ffff:192.168.1.20')).toBe(false);
    expect(isLoopback('fe80::1')).toBe(false);
    expect(isLoopback('8.8.8.8')).toBe(false);
  });

  it('refuses an address it cannot see, rather than guessing', () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback('')).toBe(false);
  });
});

/** The same rule set for the prompt-template port: named engine, default, refusal. */
describe('resolvePromptExtras', () => {
  const promptsOf = (label: string) => ({
    list: async () => label,
    save: async () => label,
    delete: async () => label,
  });
  const routerFor = (engines: Record<string, AgentExtras | undefined>, fallback = 'pi') => ({
    extrasFor: (kind: string) => engines[kind]?.prompts === undefined ? undefined : engines[kind],
    defaultExtras: () => engines[fallback],
  });
  const pi = { prompts: promptsOf('pi') } as unknown as AgentExtras;
  const openCode = { prompts: promptsOf('opencode') } as unknown as AgentExtras;
  const router = routerFor({ pi, opencode: openCode });

  it('resolves the engine a command names', async () => {
    await expect(resolvePromptExtras(router, 'pi').list('')).resolves.toBe('pi');
    await expect(resolvePromptExtras(router, 'opencode').list('')).resolves.toBe('opencode');
  });

  it('falls back to the default engine when none is named', async () => {
    await expect(resolvePromptExtras(router, undefined).list('')).resolves.toBe('pi');
    await expect(resolvePromptExtras(router, '').list('')).resolves.toBe('pi');
  });

  it('refuses an engine without prompt templates, never cross-reads', () => {
    const fileOnly = routerFor({ pi, opencode: { mcp: pi.mcp } as unknown as AgentExtras });
    expect(() => resolvePromptExtras(fileOnly, 'opencode')).toThrow(UnsupportedByHostError);
    expect(() => resolvePromptExtras(fileOnly, 'opencode')).toThrow(/opencode engine has no prompt templates/);
    expect(() => resolvePromptExtras(fileOnly, 'codex')).toThrow(/codex engine has no prompt templates/);
  });

  it('delete passes the source through', async () => {
    let seen: unknown;
    const router2 = {
      extrasFor: () => ({ prompts: { ...promptsOf('x'), delete: async (...args: unknown[]) => { seen = args; } } }),
      defaultExtras: () => undefined,
    };
    await resolvePromptExtras(router2, 'opencode').delete('n', 'global', '/w', 'config');
    expect(seen).toEqual(['n', 'global', '/w', 'config']);
  });
});
