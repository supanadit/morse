import {
  SessionEngine,
  type AgentEvent,
  type AgentGateway,
  type AgentGatewayFactory,
  type AgentSessionInfo,
  type AgentSessionState,
  type ModelRef,
  type PromptMode,
  type WorkspaceRef,
} from '@morse/agent';
import { describe, expect, it } from 'vitest';
import { AgentUnavailableError, UnsupportedByHostError } from '../errors.js';
import { silentLogger } from '../logger.js';
import type { SessionCatalog, SessionStore } from './ports.js';
import { toSessionRecord, type MorseSessionRecord } from './record.js';
import { AgentRouter, RoutedGateway } from './agent-router.js';

/**
 * The router is the one place that decides which engine owns a session and what
 * Morse calls it. What matters here: an id is resolved through the index to the
 * owning engine (never a different one with the same engine id), every state a
 * caller or subscriber sees is labelled with the derived id, a fork re-keys the
 * running session and writes the child under its parent, and a delete reaches
 * the owning engine before the row disappears.
 */

const logger = silentLogger;

/** A store in memory — the file store's own persistence is tested separately. */
class MemoryStore implements SessionStore {
  readonly rows = new Map<string, MorseSessionRecord>();

  async list(): Promise<MorseSessionRecord[]> {
    return [...this.rows.values()];
  }

  async read(id: string): Promise<MorseSessionRecord | undefined> {
    return this.rows.get(id);
  }

  async write(record: MorseSessionRecord): Promise<void> {
    this.rows.set(record.id, record);
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

/** Every catalog in this file refuses to list: the router must never ask. */
class RecordingCatalog implements SessionCatalog {
  readonly removed: string[] = [];

  async list(): Promise<never> {
    throw new Error('the router must serve listings from the index, not a catalog');
  }

  async remove(id: string): Promise<void> {
    this.removed.push(id);
  }
}

class FakeGateway implements AgentGateway {
  current: AgentSessionState;
  /** The engine id this session moves to on a fork, when one is configured. */
  private readonly forkTo: string | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(state: AgentSessionState, forkTo?: string) {
    this.current = state;
    this.forkTo = forkTo;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  state(): Promise<AgentSessionState> {
    return Promise.resolve(this.current);
  }

  history(): Promise<{ entries: never[]; hasOlder: boolean }> {
    return Promise.resolve({ entries: [], hasOlder: false });
  }

  prompt(_text: string, _mode: PromptMode): Promise<'started'> {
    return Promise.resolve('started');
  }

  forkMessages(): Promise<never[]> {
    return Promise.resolve([]);
  }

  fork(): Promise<{ text: string; cancelled: boolean }> {
    if (this.forkTo === undefined) {
      return Promise.resolve({ text: '', cancelled: true });
    }
    this.current = { ...this.current, sessionId: this.forkTo };
    return Promise.resolve({ text: 'the dropped prompt', cancelled: false });
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  setModel(): Promise<void> {
    return Promise.resolve();
  }

  setThinkingLevel(): Promise<void> {
    return Promise.resolve();
  }

  compact(): Promise<void> {
    return Promise.resolve();
  }

  respondToInteraction(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeEngine extends SessionEngine {
  readonly factory: AgentGatewayFactory;
  readonly created: { workspace: WorkspaceRef; sessionId?: string; mode?: string }[] = [];
  readonly probed: { workspace: WorkspaceRef; engine?: string; model?: ModelRef }[] = [];
  declare scan?: () => Promise<AgentSessionInfo[]>;

  constructor(
    readonly kind: string,
    private readonly gatewayFor: (input: {
      workspace: WorkspaceRef;
      sessionId?: string;
      mode?: string;
    }) => FakeGateway,
    scan?: () => Promise<AgentSessionInfo[]>,
    private readonly probe?: (input: {
      workspace: WorkspaceRef;
      engine?: string;
      model?: ModelRef;
    }) => FakeGateway,
  ) {
    super();
    this.factory = {
      create: (input) => {
        this.created.push(input);
        return Promise.resolve(this.gatewayFor(input));
      },
      ...(probe === undefined
        ? {}
        : {
            probeDefaults: (input: {
              workspace: WorkspaceRef;
              engine?: string;
              model?: ModelRef;
            }) => {
              this.probed.push(input);
              return Promise.resolve(probe(input));
            },
          }),
    };
    if (scan !== undefined) {
      this.scan = scan;
    }
  }
}

function state(overrides: Partial<AgentSessionState> = {}): AgentSessionState {
  return {
    workspace: { cwd: '/work/project', name: 'project' },
    thinkingLevel: 'medium',
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    streaming: false,
    ...overrides,
  };
}

function recordOf(
  kind: string,
  engineSessionId: string,
  overrides: Partial<MorseSessionRecord> = {},
): MorseSessionRecord {
  const record = toSessionRecord(kind, {
    sessionId: engineSessionId,
    cwd: '/work/project',
    updatedAt: 1_000,
    messageCount: 1,
    token: 't',
  });
  return { ...record, ...overrides };
}

function build(options: {
  store?: MemoryStore;
  engines: {
    kind: string;
    label?: string;
    gatewayFor?: (input: {
      workspace: WorkspaceRef;
      sessionId?: string;
      mode?: string;
    }) => FakeGateway;
    probe?: (input: { workspace: WorkspaceRef; engine?: string }) => FakeGateway;
    scan?: () => Promise<AgentSessionInfo[]>;
    catalog?: SessionCatalog;
    default?: boolean;
  }[];
  freshMs?: number;
}): { router: AgentRouter; store: MemoryStore; engines: Map<string, FakeEngine> } {
  const store = options.store ?? new MemoryStore();
  const router = new AgentRouter({
    store,
    defaultWorkspace: { cwd: '/work/project', name: 'project' },
    logger,
    freshMs: options.freshMs ?? 0, // Scans by default; debounce is asserted on its own.
  });
  const engines = new Map<string, FakeEngine>();
  for (const spec of options.engines) {
    const engine = new FakeEngine(
      spec.kind,
      spec.gatewayFor ?? (() => new FakeGateway(state({ sessionId: `${spec.kind}-new` }))),
      spec.scan,
      spec.probe,
    );
    engines.set(spec.kind, engine);
    router.register(engine, {
      ...(spec.label === undefined ? {} : { label: spec.label }),
      ...(spec.catalog === undefined ? {} : { catalog: spec.catalog }),
      ...(spec.default === undefined ? {} : { default: spec.default }),
    });
  }
  return { router, store, engines };
}

describe('AgentRouter', () => {
  it('resolves a Morse id to the owning engine, and re-keys the state it reports', async () => {
    const piEngineId = 'pi-session-1';
    // Two engines with the *same* engine id prove routing cannot go by id alone.
    const piRecord = recordOf('pi', piEngineId);
    const openCodeRecord = recordOf('opencode', piEngineId);
    const store = new MemoryStore();
    store.rows.set(piRecord.id, piRecord);
    store.rows.set(openCodeRecord.id, openCodeRecord);
    expect(piRecord.id).not.toBe(openCodeRecord.id);

    // The adapter names the session by pi's UUID even though it keys it by the
    // session file; the router must keep that name alongside Morse's id.
    const inner = new FakeGateway(state({ sessionId: piEngineId, engineSessionId: 'pi-uuid' }));
    const { router, engines } = build({
      store,
      engines: [
        { kind: 'pi', gatewayFor: () => inner },
        { kind: 'opencode', gatewayFor: () => new FakeGateway(state({ sessionId: piEngineId })) },
      ],
    });

    const gateway = (await router.create({
      workspace: { cwd: '/work/project', name: 'project' },
      sessionId: piRecord.id,
    })) as RoutedGateway;
    // Only pi was asked, and it was handed pi's own session id.
    expect(engines.get('pi')?.created).toEqual([
      { workspace: { cwd: '/work/project', name: 'project' }, sessionId: piEngineId },
    ]);
    expect(engines.get('opencode')?.created).toEqual([]);

    const routed = await gateway.state();
    expect(routed.sessionId).toBe(piRecord.id);
    expect(routed.engineSessionId).toBe('pi-uuid');

    const seen: AgentEvent[] = [];
    gateway.subscribe((event) => seen.push(event));
    inner.emit({
      type: 'agent/ready',
      at: 1,
      state: state({ sessionId: piEngineId }),
    });
    expect(seen).toHaveLength(1);
    const ready = seen[0];
    expect(ready?.type).toBe('agent/ready');
    expect(ready?.type === 'agent/ready' ? ready.state.sessionId : undefined).toBe(piRecord.id);
    // An engine that names its session no other way is stamped from its id.
    expect(ready?.type === 'agent/ready' ? ready.state.engineSessionId : undefined).toBe(piEngineId);
  });

  it('seeds the index under the derived id as soon as a new session reports one', async () => {
    const { router, store } = build({
      engines: [
        {
          kind: 'pi',
          gatewayFor: () =>
            new FakeGateway(
              state({
                sessionId: 'fresh-engine-id',
                sessionTitle: 'Fix the parser',
                counts: {
                  userMessages: 1,
                  assistantMessages: 1,
                  toolCalls: 0,
                  toolResults: 0,
                  totalMessages: 2,
                },
              }),
            ),
        },
      ],
    });

    const gateway = await router.create({ workspace: { cwd: '/work/project', name: 'project' } });
    const opened = await gateway.state();
    const expected = recordOf('pi', 'fresh-engine-id');
    expect(opened.sessionId).toBe(expected.id);

    const row = await store.read(expected.id);
    expect(row).toMatchObject({
      id: expected.id,
      title: 'Fix the parser',
      cwd: '/work/project',
      engineRef: { engine: 'pi', sessionId: 'fresh-engine-id' },
      messageCount: 2,
    });
  });

  it('re-keys a fork: the child gets a new id, the parent row stays, and the fork names it', async () => {
    const parentEngineId = 'parent-engine';
    const parentRecord = recordOf('pi', parentEngineId);
    const store = new MemoryStore();
    store.rows.set(parentRecord.id, parentRecord);
    const { router } = build({
      store,
      engines: [
        {
          kind: 'pi',
          gatewayFor: () => new FakeGateway(state({ sessionId: parentEngineId }), 'child-engine'),
        },
      ],
    });

    const gateway = await router.create({ sessionId: parentRecord.id });
    expect((await gateway.state()).sessionId).toBe(parentRecord.id);

    const forked = await gateway.fork('entry-1');
    expect(forked).toEqual({ text: 'the dropped prompt', cancelled: false });

    const child = recordOf('pi', 'child-engine');
    const childRow = await store.read(child.id);
    expect(childRow).toMatchObject({ id: child.id, parentId: parentRecord.id });
    // The session continues under the fork's id, and the parent is still listed.
    expect((await gateway.state()).sessionId).toBe(child.id);
    expect(await store.read(parentRecord.id)).toMatchObject({ id: parentRecord.id });
  });

  it('reports an id no engine holds instead of opening an arbitrary session', async () => {
    const { router, engines } = build({ engines: [{ kind: 'pi' }] });
    await expect(
      router.create({ workspace: { cwd: '/work/project', name: 'project' }, sessionId: 'not-indexed' }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(engines.get('pi')?.created).toEqual([]);
  });

  it('reports a session whose engine is not installed', async () => {
    const store = new MemoryStore();
    const record = recordOf('pi', 'pi-session-1');
    store.rows.set(record.id, record);
    const { router } = build({ store, engines: [{ kind: 'opencode' }] });
    await expect(router.create({ sessionId: record.id })).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it('deletes through the owning engine, then forgets only that row', async () => {
    const piCatalog = new RecordingCatalog();
    const openCodeCatalog = new RecordingCatalog();
    const piRecord = recordOf('pi', 'pi-session-1');
    const openCodeRecord = recordOf('opencode', 'oc-session-1');
    const store = new MemoryStore();
    store.rows.set(piRecord.id, piRecord);
    store.rows.set(openCodeRecord.id, openCodeRecord);
    const { router } = build({
      store,
      engines: [
        { kind: 'pi', catalog: piCatalog },
        { kind: 'opencode', catalog: openCodeCatalog },
      ],
    });

    await router.remove(piRecord.id);
    expect(piCatalog.removed).toEqual(['pi-session-1']);
    expect(openCodeCatalog.removed).toEqual([]);
    expect(await store.read(piRecord.id)).toBeUndefined();
    expect(await store.read(openCodeRecord.id)).toMatchObject({ id: openCodeRecord.id });
  });

  it('refuses to delete when the owning engine has no catalog', async () => {
    const record = recordOf('pi', 'pi-session-1');
    const store = new MemoryStore();
    store.rows.set(record.id, record);
    const { router } = build({ store, engines: [{ kind: 'pi' }] });
    await expect(router.remove(record.id)).rejects.toBeInstanceOf(UnsupportedByHostError);
    expect(await store.read(record.id)).toMatchObject({ id: record.id });
  });

  it('reports every engine with its label and marks exactly one default', () => {
    const { router } = build({
      engines: [
        { kind: 'pi', label: 'pi' },
        { kind: 'opencode', label: 'OpenCode', default: true },
      ],
    });

    expect(router.engineOptions()).toEqual([
      { kind: 'pi', label: 'pi' },
      { kind: 'opencode', label: 'OpenCode', default: true },
    ]);
    expect(router.defaultEngineKind).toBe('opencode');
  });

  it('creates a new session in the chosen engine and forwards its mode', async () => {
    const { router, engines } = build({
      engines: [{ kind: 'pi', default: true }, { kind: 'opencode' }],
    });

    await router.create({
      workspace: { cwd: '/work/project', name: 'project' },
      engine: 'opencode',
      mode: 'plan',
    });

    expect(engines.get('opencode')?.created).toEqual([
      { workspace: { cwd: '/work/project', name: 'project' }, mode: 'plan' },
    ]);
    expect(engines.get('pi')?.created).toEqual([]);
  });

  it('probes the chosen engine rather than the default', async () => {
    const { router, engines } = build({
      engines: [
        { kind: 'pi', default: true },
        {
          kind: 'opencode',
          probe: () => new FakeGateway(state({ mode: 'plan', availableModes: [] })),
        },
      ],
    });

    const probe = await router.probeDefaults({
      workspace: { cwd: '/work/project', name: 'project' },
      engine: 'opencode',
    });
    expect((await probe.state()).mode).toBe('plan');
    expect(engines.get('opencode')?.probed).toEqual([
      { workspace: { cwd: '/work/project', name: 'project' }, engine: 'opencode' },
    ]);
    expect(engines.get('pi')?.probed).toEqual([]);
  });

  it('refuses a chosen engine that is not installed', async () => {
    const { router, engines } = build({ engines: [{ kind: 'pi' }] });
    await expect(
      router.create({
        workspace: { cwd: '/work/project', name: 'project' },
        engine: 'opencode',
      }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(engines.get('pi')?.created).toEqual([]);
  });
});

describe('AgentRouter catalog', () => {
  function info(kind: string, sessionId: string, overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
    return {
      sessionId,
      cwd: '/work/project',
      title: `${kind} ${sessionId}`,
      updatedAt: 1_000,
      messageCount: 1,
      token: 't1',
      ...overrides,
    };
  }

  it('lists both engines\' sessions from the index, newest first, grouped by project cap', async () => {
    const store = new MemoryStore();
    for (const [kind, id, updatedAt] of [
      ['pi', 'a', 1_000],
      ['opencode', 'b', 2_000],
      ['pi', 'c', 3_000],
    ] as const) {
      const record = toSessionRecord(kind, info(kind, id, { updatedAt }));
      store.rows.set(record.id, record);
    }
    const { router } = build({
      store,
      engines: [
        { kind: 'pi', catalog: new RecordingCatalog() },
        { kind: 'opencode', catalog: new RecordingCatalog() },
      ],
    });

    const listed = await router.list();
    expect(listed.map((session) => session.title)).toEqual(['pi c', 'opencode b', 'pi a']);
  });

  it('adds a session created outside Morse on the next read and does not re-scan inside the window', async () => {
    const store = new MemoryStore();
    let scans = 0;
    let reported: AgentSessionInfo[] = [];
    const { router } = build({
      store,
      freshMs: 60_000,
      engines: [
        {
          kind: 'pi',
          scan: () => {
            scans += 1;
            return Promise.resolve(reported);
          },
        },
      ],
    });

    expect(await router.list()).toEqual([]);
    expect(scans).toBe(1);

    reported = [info('pi', 'outside-1')];
    // Inside the window: the cached index answers, no engine read.
    expect(await router.list()).toEqual([]);
    expect(scans).toBe(1);

    // Past the window (forced), the new session appears.
    await router.ensureFresh(true);
    const listed = await router.list();
    expect(listed.map((session) => session.title)).toEqual(['pi outside-1']);
    expect(scans).toBe(2);
  });

  it('leaves an engine\'s rows alone when its scan fails, and still merges the other engine', async () => {
    const piRecord = toSessionRecord('pi', info('pi', 'existing'));
    const store = new MemoryStore();
    store.rows.set(piRecord.id, piRecord);
    const { router } = build({
      store,
      engines: [
        {
          kind: 'pi',
          scan: () => Promise.reject(new Error('pi is down')),
        },
        {
          kind: 'opencode',
          scan: () => Promise.resolve([info('opencode', 'new-one')]),
        },
      ],
    });

    const listed = await router.list();
    expect(listed.map((session) => session.title).sort()).toEqual(['opencode new-one', 'pi existing']);
    // Explicitly: the failed engine has no way to report its rows deleted.
    expect(await store.read(piRecord.id)).toMatchObject({ id: piRecord.id });
  });

  it('never removes the row of a session this process is running, even when a stale report omits it', async () => {
    // The engine reports nothing (its session file is still mid-write while the
    // conversation runs). The row seeded by the running gateway must survive.
    const store = new MemoryStore();
    let scans = 0;
    const { router } = build({
      store,
      freshMs: 0,
      engines: [
        {
          kind: 'pi',
          gatewayFor: () => new FakeGateway(state({ sessionId: 'live-engine-id' })),
          scan: () => {
            scans += 1;
            return Promise.resolve([]);
          },
        },
      ],
    });

    const gateway = await router.create({ workspace: { cwd: '/work/project', name: 'project' } });
    const id = (await gateway.state()).sessionId;
    expect(id).toBeDefined();
    expect(await store.read(id ?? '')).toMatchObject({ id });

    // The stale report arrives (a sidebar read, a refresh).
    await router.list();
    expect(scans).toBeGreaterThan(0);
    expect(await store.read(id ?? '')).toMatchObject({ id });

    // Once the gateway is disposed the session is not running any more, so a
    // report that still omits it may clean the row up.
    await gateway.dispose();
    await router.list();
    expect(await store.read(id ?? '')).toBeUndefined();
  });

  it('pages, searches and counts from the index without engine catalogs', async () => {
    const store = new MemoryStore();
    for (let index = 0; index < 15; index += 1) {
      const record = toSessionRecord(
        'pi',
        info('pi', `s${index}`, { title: index === 14 ? 'needle session' : `session ${index}`, updatedAt: 1_000 + index }),
      );
      store.rows.set(record.id, record);
    }
    const { router } = build({ store, engines: [{ kind: 'pi', catalog: new RecordingCatalog() }] });

    const first = await router.list();
    expect(first).toHaveLength(10); // The per-project cap.
    expect((await router.countByProject()).get('/work/project')).toBe(15);

    const page = await router.listPage({ cwd: '/work/project', offset: 10, limit: 10 });
    expect(page.sessions).toHaveLength(5);
    expect(page.hasMore).toBe(false);

    const found = await router.search('needle');
    expect(found.map((session) => session.title)).toEqual(['needle session']);
  });
});
