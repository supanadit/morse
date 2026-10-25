import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionState, ModelRef } from '@morse/agent';
import { UnsupportedByHostError, silentLogger } from '@morse/system';
import type { OpenCodeApi, OpenCodePage } from './internal/client.js';
import type { OpenCodeEventStream } from './internal/event-stream.js';
import type { ApiModel } from './internal/model-mapping.js';
import { OpenCodeEngine } from './opencode-engine.js';

/**
 * The engine turns OpenCode's server into a Morse engine: the session report that
 * reconcile merges, the draft catalog with no session behind it, and a dispose
 * that only reaches the server when Morse started it.
 */

const WORKSPACE = { cwd: '/work/project', name: 'project' };

interface SessionRow {
  id: string;
  title?: string;
  time?: { created?: number; updated?: number };
  location?: { directory?: string };
  outcome?: string;
  fork?: { sessionID?: string };
}

class FakeApi {
  readonly calls: { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown }[] = [];

  constructor(private readonly sessions: SessionRow[]) {}

  get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    if (path === '/model') {
      return Promise.resolve([
        {
          id: 'flint-40b-free',
          providerID: 'opencode',
          name: 'Flint 40B Free',
          variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
          limit: { context: 100_000, output: 8_000 },
          capabilities: { input: ['text'] },
        },
      ] satisfies ApiModel[] as unknown as T);
    }
    if (path === '/command') {
      return Promise.resolve([{ name: 'init', description: 'setup' }] as unknown as T);
    }
    if (path === '/skill') {
      return Promise.resolve([{ id: 'opencode', name: 'OpenCode', description: 'about it' }] as unknown as T);
    }
    if (path === '/agent') {
      return Promise.resolve([{ id: 'build', name: 'Build' }] as unknown as T);
    }
    const id = path.split('/')[2];
    const session = this.sessions.find((row) => row.id === id);
    return session === undefined ? Promise.reject(new Error('not found')) : Promise.resolve(session as unknown as T);
  }

  page<T>(path: string): Promise<OpenCodePage<T>> {
    this.calls.push({ method: 'GET', path });
    return Promise.resolve({ data: this.sessions as unknown as T[] });
  }

  post<T>(path: string, body?: unknown): Promise<T | undefined> {
    this.calls.push({ method: 'POST', path, body });
    if (path === '/session') {
      return Promise.resolve({
        id: 'ses_new',
        time: { created: 5_000, updated: 5_000 },
        location: { directory: '/work/project' },
      } as unknown as T);
    }
    return Promise.resolve(undefined);
  }

  delete(path: string): Promise<void> {
    this.calls.push({ method: 'DELETE', path });
    return Promise.resolve();
  }
}

function engineWith(options: {
  sessions?: SessionRow[];
  owned?: boolean;
} = {}): {
  engine: OpenCodeEngine;
  api: FakeApi;
  closed: { stream: ReturnType<typeof vi.fn>; connection: ReturnType<typeof vi.fn> };
} {
  const api = new FakeApi(
    options.sessions ?? [
      {
        id: 'ses_1',
        title: 'First',
        time: { created: 1_000, updated: 2_000 },
        location: { directory: '/work/project' },
        outcome: 'succeeded',
      },
      {
        id: 'ses_child',
        time: { created: 2_100, updated: 2_100 },
        location: { directory: '/work/project' },
        fork: { sessionID: 'ses_1' },
      },
      // No directory: it cannot be grouped, so it is not reported.
      { id: 'ses_nowhere', time: { created: 3_000, updated: 3_000 } },
    ],
  );
  const closed = {
    stream: vi.fn(() => Promise.resolve()),
    connection: vi.fn(() => Promise.resolve()),
  };
  const engine = new OpenCodeEngine({
    connection: {
      baseUrl: 'http://127.0.0.1:1',
      password: 'pw',
      owned: options.owned ?? false,
      close: closed.connection,
    },
    api: api as unknown as OpenCodeApi,
    stream: {
      close: closed.stream,
      subscribe: () => () => undefined,
    } as unknown as OpenCodeEventStream,
    logger: silentLogger,
  });
  return { engine, api, closed };
}

describe('OpenCodeEngine', () => {
  it('reports the server\'s sessions in the engine\'s own terms', async () => {
    const { engine } = engineWith();
    expect(engine.kind).toBe('opencode');
    expect(engine.engine).toBe(engine);

    const reported = await engine.scan?.();
    expect(reported).toEqual([
      {
        sessionId: 'ses_1',
        title: 'First',
        cwd: '/work/project',
        createdAt: 1_000,
        updatedAt: 2_000,
        messageCount: 0,
        token: '2000:succeeded',
      },
      {
        sessionId: 'ses_child',
        title: undefined,
        cwd: '/work/project',
        createdAt: 2_100,
        updatedAt: 2_100,
        messageCount: 0,
        parentSessionId: 'ses_1',
        token: '2100:',
      },
    ]);
  });

  it('creates a session for a workspace and attaches by id', async () => {
    const { engine, api } = engineWith();

    const created = await engine.factory.create({ workspace: WORKSPACE });
    expect(api.calls.some((call) => call.method === 'POST' && call.path === '/session')).toBe(true);
    expect((await created.state()).sessionId).toBe('ses_new');
    await created.dispose();

    const resumed = await engine.factory.create({ workspace: WORKSPACE, sessionId: 'ses_1' });
    expect(api.calls.some((call) => call.method === 'GET' && call.path === '/session/ses_1')).toBe(true);
    expect((await resumed.state()).sessionId).toBe('ses_1');
    await resumed.dispose();
  });

  it('probes the catalogs without creating a session', async () => {
    const { engine, api } = engineWith({ sessions: [] });
    const probe = await engine.factory.probeDefaults({ workspace: WORKSPACE });
    const state = await probe.state();

    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([]);
    expect(api.calls.map((call) => call.path).sort()).toEqual(['/agent', '/command', '/model', '/skill']);
    expect(state.availableModels).toHaveLength(1);
    expect(state.availableCommands.map((command) => command.name)).toEqual(['init', 'OpenCode']);
    expect(state.availableThinkingLevels).toEqual([]);

    await probe.dispose();
    // A draft refuses what it cannot do instead of pretending.
    await expect(probe.prompt('hi', 'new')).rejects.toBeInstanceOf(UnsupportedByHostError);
  });

  it('offers the picked model\'s levels on a probe', async () => {
    const { engine } = engineWith({ sessions: [] });
    const model: ModelRef = { provider: 'opencode', id: 'flint-40b-free', name: 'Flint 40B Free' };
    const probe = await engine.factory.probeDefaults({ workspace: WORKSPACE, model });
    const state: AgentSessionState = await probe.state();
    expect(state.model).toMatchObject({ provider: 'opencode', id: 'flint-40b-free' });
    expect(state.availableThinkingLevels).toEqual(['low', 'medium', 'high']);
    expect(state.thinkingLevel).toBe('medium');
  });

  it('closes the stream and the connection on dispose', async () => {
    const { engine, closed } = engineWith({ owned: true });
    await engine.dispose();
    expect(closed.stream).toHaveBeenCalledTimes(1);
    expect(closed.connection).toHaveBeenCalledTimes(1);

    // An owned connection stops the server; an attached one is a no-op (the
    // connection itself enforces that, covered where it is created).
    expect(engine.owned).toBe(true);
  });
});
