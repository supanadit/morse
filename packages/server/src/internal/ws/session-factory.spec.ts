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
import {
  isLoopback,
  resolveFixExtras,
  resolveMcpExtras,
  resolvePromptExtras,
} from './session-factory-helpers.js';
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
      traces: [],
    })),
    history: vi.fn(() => ({ entries: [], hasMore: false, traces: [] })),
    send: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    newDiscussion: vi.fn(),
    clear: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    routing: vi.fn(() => null),
    usages: vi.fn(() => []),
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
function factoryWith(
  bot: BotService | undefined,
  extras?: AgentExtras,
  options: { canOpen?: (cwd: string) => boolean; defaultCwd?: string } = {},
): MorseSessionFactory {
  const registry = {
    subscribe: () => () => undefined,
    onRemoval: () => () => undefined,
    activeKeyOf: () => undefined,
    hotKeys: () => [],
    stateOf: () => undefined,
    defaultWorkspace:
      options.defaultCwd === undefined ? WORKSPACE : { ...WORKSPACE, cwd: options.defaultCwd },
    draftDefaults: async () => undefined,
    listSessions: async () => [],
    sessionCounts: async () => [] as [string, number][],
    listProjects: async () => [],
    searchSessions: async () => [],
    dispose: async () => undefined,
  } as unknown as SessionRegistry;
  const router = {
    defaultExtras: () => extras,
    engineOptions: () => (extras === undefined ? [] : [{ kind: 'pi', label: 'pi' }]),
    extrasFor: () => extras,
    agentFor: () => undefined,
    dispose: async () => undefined,
  } as unknown as FactoryArgs[6];
  return new MorseSessionFactory(
    registry,
    new SessionTranscriptStore(),
    { canOpen: options.canOpen ?? (() => true) } as unknown as FactoryArgs[2],
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

  it('advertises configFix only when an engine exposes a fix', () => {
    const fix = () => Promise.resolve({ ok: true, issues: [] });
    expect(factoryWith(undefined, { fix } as unknown as AgentExtras).capabilities().configFix).toBe(
      true,
    );
    // No engine, no fix command: the frontend hides the button instead of
    // offering one this host would refuse.
    expect(factoryWith(undefined).capabilities().configFix).toBe(false);
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
    // No handle: the controller passes the payload through, so the service reads
    // `undefined` as "every bot in this conversation".
    expect(bot.calls.stop).toHaveBeenCalledWith('dm-x', undefined);
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

    // The page, then the presence of the conversation (null: no round in flight).
    // Opening re-sends both, so a chat the reader returns to mid-round is not
    // drawn as idle, and its counters are not lost.
    expect(messages.slice(-2)).toEqual([
      {
        type: 'bot/transcript',
        payload: {
          conversationId: 'dm-x',
          entries: [{ id: 'line-1', author: { role: 'system' }, text: 'hello', at: 2 }],
          replace: true,
          hasMore: false,
        },
      },
      { type: 'bot/routing', payload: { conversationId: 'dm-x', state: null } },
    ]);
  });

  it('pushes a finished turn into every open room', () => {
    const bot = fakeBot();
    const gateway = new MorseGateway(factoryWith(bot.service), silentLogger, {});
    const socket = fakeSocket();
    gateway.handleConnection(socket);
    const trace = {
      id: 'turn-1',
      conversationId: 'dm-x',
      username: 'forge',
      name: 'Forge',
      startedAt: 1,
      endedAt: 2,
      status: 'done' as const,
      steps: [],
      handoffs: [],
    };

    bot.emit({
      type: 'transcript',
      conversationId: 'dm-x',
      entries: [],
      replace: false,
      traces: [trace],
    });

    // The turn travels as an append of no lines: the transcript the client holds
    // is unchanged, and the room learns what history it now has.
    const sent = (socket.send as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(JSON.parse(sent.at(-1)?.[0] ?? '{}')).toEqual({
      type: 'bot/transcript',
      payload: { conversationId: 'dm-x', entries: [], replace: false, traces: [trace] },
    });
    gateway.handleDisconnect(socket);
  });

  it('broadcasts routing state and forgets the feed when the socket disconnects', () => {
    const bot = fakeBot();
    const factory = factoryWith(bot.service);
    const gateway = new MorseGateway(factory, silentLogger, {});
    const socket = fakeSocket();

    gateway.handleConnection(socket);
    expect(bot.subscribe).toHaveBeenCalledTimes(1);

    bot.emit({
      type: 'routing',
      conversationId: 'dm-x',
      state: { conversationId: 'dm-x', active: [], queued: [] },
    });
    const sent = (socket.send as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(JSON.parse(sent.at(-1)?.[0] ?? '{}')).toMatchObject({
      type: 'bot/routing',
      payload: { conversationId: 'dm-x', state: { conversationId: 'dm-x', active: [], queued: [] } },
    });

    // A turn's counters ride the same feed, keyed by the conversation they belong
    // to, so the composer's ring follows the bot that just answered.
    bot.emit({
      type: 'usage',
      usage: {
        conversationId: 'dm-x',
        username: 'forge',
        bot: 'Forge',
        contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
      },
    });
    expect(JSON.parse(sent.at(-1)?.[0] ?? '{}')).toMatchObject({
      type: 'bot/usage',
      payload: { conversationId: 'dm-x', username: 'forge', bot: 'Forge' },
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

/** An engine's MCP port whose `status` is a spy, plus no Fix action. */
function mcpOnlyExtras(status: (...args: unknown[]) => Promise<unknown>): AgentExtras {
  return {
    mcp: {
      configSignature: async () => '',
      status: status as NonNullable<AgentExtras['mcp']>['status'],
      add: async () => undefined,
      remove: async () => undefined,
      setEnabled: async () => undefined,
      trustProject: async () => undefined,
    },
  };
}

/**
 * Probing and the config Fix action. `probe` turns the fast list into live
 * connection state; `configFix` rewrites a file the reader cannot otherwise
 * write, so its arguments are checked before any engine sees them.
 */
describe('mcpStatus probing', () => {
  /** Sends one `host/command` and returns the answer the host emitted. */
  async function answer(
    controller: ReturnType<MorseSessionFactory['createFor']>,
    messages: HostToClientMessage[],
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string } | undefined> {
    await controller.handleClientMessage({
      type: 'host/command',
      payload: { command: 'mcpStatus', args, requestId: 'mcp-1' },
    });
    const last = messages.at(-1);
    return last?.type === 'host/command/result' ? last.payload : undefined;
  }

  it('forwards probe:true to the engine, and a fast read otherwise', async () => {
    const status = vi.fn(async () => ({ servers: [], errors: [] }));
    const { controller, messages } = connect(factoryWith(undefined, mcpOnlyExtras(status)));

    expect(await answer(controller, messages, { scope: 'global', probe: true })).toMatchObject({
      ok: true,
    });
    expect(status).toHaveBeenLastCalledWith(undefined, { probe: true });

    await answer(controller, messages, { scope: 'global' });
    expect(status).toHaveBeenLastCalledWith(undefined, { probe: false });
  });
});

/**
 * The Fix command's argument gate: the engine owns the path rule (it is the one
 * that knows its config files), so the host only refuses what it cannot even
 * describe — a missing fileId, path or scope — and forwards the rest intact.
 */
describe('configFix', () => {
  async function fix(
    extras: AgentExtras | undefined,
    args: Record<string, unknown>,
  ): Promise<{
    controller: ReturnType<MorseSessionFactory['createFor']>;
    messages: HostToClientMessage[];
  }> {
    const host = connect(factoryWith(undefined, extras));
    await host.controller.handleClientMessage({
      type: 'host/command',
      payload: { command: 'configFix', args, requestId: 'fix-1' },
    });
    return host;
  }

  const lastResult = (
    messages: HostToClientMessage[],
  ): { ok: boolean; data?: unknown; error?: string } | undefined => {
    const last = messages.at(-1);
    return last?.type === 'host/command/result' ? last.payload : undefined;
  };

  it('forwards a valid request with every field the engine needs', async () => {
    const engineFix = vi.fn(async () => ({
      ok: true,
      path: '/repo/.pi/mcp.json',
      scope: 'project',
      issues: [],
    }));
    const result = await fix(
      { fix: engineFix },
      { engine: 'pi', fileId: 'mcp', path: '/repo/.pi/mcp.json', scope: 'project', cwd: '/repo' },
    );

    expect(engineFix).toHaveBeenCalledWith({
      fileId: 'mcp',
      path: '/repo/.pi/mcp.json',
      scope: 'project',
      cwd: '/repo',
    });
    expect(lastResult(result.messages)).toMatchObject({
      ok: true,
      data: { ok: true, path: '/repo/.pi/mcp.json', scope: 'project' },
    });
  });

  it('refuses a request without a usable fileId, path or scope', async () => {
    const engineFix = vi.fn(async () => ({ ok: true, issues: [] }));

    const noFileId = await fix({ fix: engineFix }, { path: '/repo/mcp.json', scope: 'global' });
    expect(lastResult(noFileId.messages)?.ok).toBe(false);

    const noPath = await fix({ fix: engineFix }, { fileId: 'mcp', scope: 'global' });
    expect(lastResult(noPath.messages)?.ok).toBe(false);

    const noScope = await fix(
      { fix: engineFix },
      { fileId: 'mcp', path: '/repo/mcp.json', scope: 'local' },
    );
    expect(lastResult(noScope.messages)?.ok).toBe(false);

    expect(engineFix).not.toHaveBeenCalled();
  });

  it('refuses an engine with no Fix action instead of pretending', async () => {
    const result = await fix(mcpOnlyExtras(async () => ({ servers: [], errors: [] })), {
      engine: 'pi',
      fileId: 'mcp',
      path: '/repo/mcp.json',
      scope: 'global',
    });

    expect(lastResult(result.messages)).toMatchObject({ ok: false });
  });

  it('refuses a project fix whose directory the policy does not allow', async () => {
    const engineFix = vi.fn(async () => ({ ok: true, issues: [] }));
    const { controller, messages } = connect(
      factoryWith(undefined, { fix: engineFix }, { canOpen: (cwd) => cwd !== '/forbidden' }),
    );

    await controller.handleClientMessage({
      type: 'host/command',
      payload: {
        command: 'configFix',
        args: {
          fileId: 'mcp',
          path: '/forbidden/.pi/mcp.json',
          scope: 'project',
          cwd: '/forbidden',
        },
        requestId: 'fix-policy',
      },
    });

    expect(lastResult(messages)).toMatchObject({ ok: false });
    expect(engineFix).not.toHaveBeenCalled();
  });

  it('fixes the user-level file with no session in front', async () => {
    const path = '/home/me/.config/opencode/opencode.json';
    const engineFix = vi.fn(async () => ({ ok: true, path, scope: 'global', issues: [] }));
    // No active session and no project in front: the global file is the whole
    // subject, so the host must not invent a directory for the request.
    const { controller, messages } = connect(
      factoryWith(undefined, { fix: engineFix }, { defaultCwd: '' }),
    );

    await controller.handleClientMessage({
      type: 'host/command',
      payload: {
        command: 'configFix',
        args: { engine: 'opencode', fileId: 'config', path, scope: 'global' },
        requestId: 'fix-global',
      },
    });

    expect(engineFix).toHaveBeenCalledWith({ fileId: 'config', path, scope: 'global' });
    expect(lastResult(messages)).toMatchObject({ ok: true, data: { ok: true } });
  });
});

/** The Fix port resolved by the same rule as the MCP and prompt ports. */
describe('resolveFixExtras', () => {
  const fixOf = (label: string) => ({ fix: async () => label });
  const routerFor = (engines: Record<string, AgentExtras | undefined>, fallback = 'pi') => ({
    extrasFor: (kind: string) => (engines[kind]?.fix === undefined ? undefined : engines[kind]),
    defaultExtras: () => engines[fallback],
  });
  const pi = fixOf('pi') as unknown as AgentExtras;
  const openCode = fixOf('opencode') as unknown as AgentExtras;

  it('resolves the engine a command names, and the default when none is', async () => {
    const router = routerFor({ pi, opencode: openCode });
    await expect(
      resolveFixExtras(router, 'opencode')({
        fileId: 'config',
        path: '/w/opencode.json',
        scope: 'global',
      }),
    ).resolves.toBe('opencode');
    await expect(
      resolveFixExtras(router, undefined)({
        fileId: 'mcp',
        path: '/w/mcp.json',
        scope: 'global',
      }),
    ).resolves.toBe('pi');
  });

  it('refuses an engine without the port, never another engine’s fix', () => {
    const router = routerFor({ pi, opencode: mcpOnlyExtras(async () => undefined) });
    expect(() => resolveFixExtras(router, 'opencode')).toThrow(UnsupportedByHostError);
    expect(() => resolveFixExtras(router, 'opencode')).toThrow(/opencode engine has no config Fix/);
  });
});
