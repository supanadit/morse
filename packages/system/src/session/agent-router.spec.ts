import {
  SessionEngine,
  type AgentChildSessionRef,
  type AgentEvent,
  type AgentGateway,
  type AgentGatewayFactory,
  type AgentHistoryEntry,
  type AgentSessionInfo,
  type AgentSessionState,
  type AgentUserMessage,
  type ModelRef,
  type PromptMode,
  type WorkspaceRef,
} from '@morse/agent';
import { describe, expect, it, vi } from 'vitest';
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
  readonly kind: string = 'pi';
  current: AgentSessionState;
  /** What `history()` serves; empty unless a test says otherwise. */
  entries: {
    role: 'user' | 'assistant' | 'tool';
    text?: string;
    name?: string;
    title?: string;
    status?: 'ok' | 'error' | 'running';
    at?: number;
    childSession?: { sessionId: string; agent?: string };
  }[] = [];
  /** Counts transcript-cache drops; omitted means the adapter has no cache. */
  refreshHistory?: () => Promise<void>;
  /** Counts config reloads; omitted means the adapter has no config to reload. */
  refreshConfig?: () => Promise<void>;
  /** The engine id this session moves to on a fork, when one is configured. */
  private readonly forkTo: string | undefined;
  /** The engine id a rewrite moves to; unset edits in place (when it commits). */
  rewriteTo: string | undefined;
  /** The dropped text a committing rewrite reports; unset makes a rewrite cancel. */
  rewriteText: string | undefined;
  /** The new session an engine's clone creates; unset makes a clone cancel. */
  cloneTo: string | undefined;
  /** What `userMessages()` offers for the edit-point lookup. */
  messages: AgentUserMessage[] = [];
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

  history(): Promise<{ entries: AgentHistoryEntry[]; hasOlder: boolean }> {
    return Promise.resolve({ entries: this.entries, hasOlder: false });
  }

  prompt(_text: string, _mode: PromptMode): Promise<'started'> {
    return Promise.resolve('started');
  }

  userMessages(): Promise<AgentUserMessage[]> {
    return Promise.resolve(this.messages);
  }

  rewrite(_entryId: string): Promise<{ text: string; cancelled: boolean }> {
    if (this.rewriteText === undefined) {
      return Promise.resolve({ text: '', cancelled: true });
    }
    // An engine that can edit in place leaves the id alone; one that cannot
    // branches, and the id moves with the new session.
    if (this.rewriteTo !== undefined) {
      this.current = { ...this.current, sessionId: this.rewriteTo };
    }
    return Promise.resolve({ text: this.rewriteText, cancelled: false });
  }

  clone(): Promise<{ cancelled: boolean }> {
    if (this.cloneTo === undefined) {
      return Promise.resolve({ cancelled: true });
    }
    this.current = { ...this.current, sessionId: this.cloneTo };
    return Promise.resolve({ cancelled: false });
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

/**
 * An engine whose factory carries the optional capabilities a test drives —
 * `configSignature`, `reloadConfig`, `probeDefaults` — without a new fixture per
 * capability.
 */
function engineWithFactory(factory: Partial<AgentGatewayFactory>, kind = 'pi'): FakeEngine {
  const engine = new FakeEngine(kind, () => new FakeGateway(state({ sessionId: `${kind}-new` })));
  Object.assign(engine.factory, factory);
  return engine;
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
    expect(ready?.type === 'agent/ready' ? ready.state.engineSessionId : undefined).toBe(
      piEngineId,
    );
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

  it('stamps a new session with the engine that created it, not the default', async () => {
    const { router, store } = build({
      engines: [
        { kind: 'pi', default: true },
        {
          kind: 'opencode',
          gatewayFor: () => new FakeGateway(state({ sessionId: 'oc-engine-id' })),
        },
      ],
    });

    const gateway = (await router.create({
      workspace: { cwd: '/work/project', name: 'project' },
      engine: 'opencode',
    })) as RoutedGateway;

    // The wrapped kind is the one whose factory produced the gateway.
    expect(gateway.kind).toBe('opencode');

    const expected = recordOf('opencode', 'oc-engine-id');
    expect((await gateway.state()).sessionId).toBe(expected.id);
    // A pi-derived id would be a different row, so the id proves the kind too.
    expect(expected.id).not.toBe(recordOf('pi', 'oc-engine-id').id);
    expect(await store.read(expected.id)).toMatchObject({
      id: expected.id,
      engineRef: { engine: 'opencode', sessionId: 'oc-engine-id' },
    });
  });

  it("resumes into the record's engine even when the default is another, and a fork keeps it", async () => {
    const record = recordOf('opencode', 'oc-engine-id');
    const store = new MemoryStore();
    store.rows.set(record.id, record);
    const { router, engines } = build({
      store,
      engines: [
        { kind: 'pi', default: true },
        {
          kind: 'opencode',
          gatewayFor: () => new FakeGateway(state({ sessionId: 'oc-engine-id' }), 'oc-forked-id'),
        },
      ],
    });

    const gateway = (await router.create({ sessionId: record.id })) as RoutedGateway;
    expect(gateway.kind).toBe('opencode');
    expect(engines.get('pi')?.created).toEqual([]);
    expect((await gateway.state()).sessionId).toBe(record.id);

    // The fork moves the engine session id, not the engine.
    await gateway.fork('entry-1');
    expect(gateway.kind).toBe('opencode');
    const forked = recordOf('opencode', 'oc-forked-id');
    expect((await gateway.state()).sessionId).toBe(forked.id);
    expect(await store.read(forked.id)).toMatchObject({
      engineRef: { engine: 'opencode', sessionId: 'oc-forked-id' },
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

  it('keeps the id when a rewrite edits in place, and forwards the user messages', async () => {
    const record = recordOf('pi', 'pi-1');
    const store = new MemoryStore();
    store.rows.set(record.id, record);
    const inner = new FakeGateway(state({ sessionId: 'pi-1' }));
    inner.messages = [{ entryId: 'entry-1', text: 'the prompt being edited' }];
    inner.rewriteText = 'the prompt being edited';
    const { router } = build({ store, engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({ sessionId: record.id });
    expect(await gateway.userMessages()).toEqual(inner.messages);
    // The row exists before the branch: an open always reads the state first.
    expect((await gateway.state()).sessionId).toBe(record.id);

    const rewritten = await gateway.rewrite('entry-1');
    expect(rewritten).toEqual({ text: 'the prompt being edited', cancelled: false });
    // In place: the id stands, so the row is the same one and no branch appears.
    expect((await gateway.state()).sessionId).toBe(record.id);
    expect(await store.read(record.id)).toMatchObject({
      engineRef: { engine: 'pi', sessionId: 'pi-1' },
    });
    expect([...store.rows.keys()]).toEqual([record.id]);
  });

  it('re-keys a rewrite that branches onto a new engine session', async () => {
    const record = recordOf('pi', 'pi-1');
    const store = new MemoryStore();
    store.rows.set(record.id, record);
    const inner = new FakeGateway(state({ sessionId: 'pi-1' }));
    inner.rewriteText = 'the prompt being edited';
    inner.rewriteTo = 'pi-edited';
    const { router } = build({ store, engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({ sessionId: record.id });
    expect((await gateway.state()).sessionId).toBe(record.id);
    const rewritten = await gateway.rewrite('entry-1');
    expect(rewritten).toEqual({ text: 'the prompt being edited', cancelled: false });

    // An engine with no edit primitive branches: the id is re-derived and the
    // new row nests under the one it was cut from. The row is written before a
    // caller reads the state again, so the sidebar never shows the old id.
    const edited = recordOf('pi', 'pi-edited');
    expect(edited.id).not.toBe(record.id);
    expect(await store.read(edited.id)).toMatchObject({
      id: edited.id,
      parentId: record.id,
      engineRef: { engine: 'pi', sessionId: 'pi-edited' },
    });
    expect((await gateway.state()).sessionId).toBe(edited.id);
    expect(await store.read(record.id)).toMatchObject({ id: record.id });
  });

  it('re-keys a clone onto the new session the engine created', async () => {
    const record = recordOf('pi', 'pi-1');
    const store = new MemoryStore();
    store.rows.set(record.id, record);
    const inner = new FakeGateway(state({ sessionId: 'pi-1' }));
    inner.cloneTo = 'pi-clone';
    const { router } = build({ store, engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({ sessionId: record.id });
    expect((await gateway.state()).sessionId).toBe(record.id);
    expect(await gateway.clone()).toEqual({ cancelled: false });

    const cloned = recordOf('pi', 'pi-clone');
    // Same as a fork: the copy's row exists before any caller reads the state.
    expect(await store.read(cloned.id)).toMatchObject({
      id: cloned.id,
      parentId: record.id,
    });
    expect((await gateway.state()).sessionId).toBe(cloned.id);
    expect(await store.read(record.id)).toMatchObject({ id: record.id });
  });

  it('leaves the session alone when a rewrite or clone is cancelled', async () => {
    const record = recordOf('pi', 'pi-1');
    const store = new MemoryStore();
    store.rows.set(record.id, record);
    const inner = new FakeGateway(state({ sessionId: 'pi-1' }));
    const { router } = build({ store, engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({ sessionId: record.id });
    expect((await gateway.state()).sessionId).toBe(record.id);
    expect(await gateway.rewrite('entry-1')).toEqual({ text: '', cancelled: true });
    expect(await gateway.clone()).toEqual({ cancelled: true });
    expect((await gateway.state()).sessionId).toBe(record.id);
    expect([...store.rows.keys()]).toEqual([record.id]);
  });

  it('translates a child link from the engine id to the Morse id a frontend opens', async () => {
    const inner = new FakeGateway(state({ sessionId: 'parent-engine' }));
    const { router } = build({
      engines: [{ kind: 'opencode', gatewayFor: () => inner }],
    });
    const gateway = await router.create({ workspace: { cwd: '/work/project', name: 'project' } });
    const child = (engineSessionId: string): AgentChildSessionRef => ({
      sessionId: engineSessionId,
      agent: 'explore',
    });

    // Live events: the tool row must link with the id `session/activate` takes.
    const seen: AgentEvent[] = [];
    gateway.subscribe((event) => seen.push(event));
    inner.emit({
      type: 'agent/tool-start',
      at: 1,
      toolCallId: 't1',
      name: 'task',
      title: 'task',
      childSession: child('child-engine-1'),
    });
    inner.emit({
      type: 'agent/tool-end',
      at: 2,
      toolCallId: 't1',
      status: 'ok',
      childSession: child('child-engine-1'),
    });
    // Other events pass untouched; the translated links must not leak into them.
    inner.emit({ type: 'agent/run-end', at: 3, reason: 'settled' });

    // Persisted history: a resumed parent's tool rows link the same way.
    inner.entries = [
      {
        role: 'tool',
        toolCallId: 't2',
        name: 'task',
        title: 'task',
        status: 'ok',
        childSession: child('child-engine-2'),
      },
    ];

    const expected = (engineSessionId: string): string => recordOf('opencode', engineSessionId).id;
    const links = seen.flatMap((event) =>
      event.type === 'agent/tool-start' || event.type === 'agent/tool-end'
        ? [event.childSession]
        : [],
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ sessionId: expected('child-engine-1'), agent: 'explore' });
    expect(links[1]).toEqual({ sessionId: expected('child-engine-1'), agent: 'explore' });
    // And the id really is one the router can open: the row exists once a scan
    // has seen it (covered by the forced-refresh test below).
    expect(expected('child-engine-1')).not.toBe('child-engine-1');
    const page = await gateway.history();
    const entry = page.entries[0];
    expect(entry?.role).toBe('tool');
    expect(entry?.role === 'tool' ? entry.childSession?.sessionId : undefined).toBe(
      expected('child-engine-2'),
    );
  });

  it('passes a caching adapter’s transcript-cache drop through to the wrapped gateway', async () => {
    const inner = new FakeGateway(state({ sessionId: 'parent-engine' }));
    let dropped = 0;
    inner.refreshHistory = () => {
      dropped += 1;
      return Promise.resolve();
    };
    const { router } = build({ engines: [{ kind: 'pi', gatewayFor: () => inner }] });
    const gateway = await router.create({ workspace: { cwd: '/work/project', name: 'project' } });
    await gateway.refreshHistory?.();
    expect(dropped).toBe(1);
    // And a gateway whose adapter cannot refresh simply reports no capability.
    const plain = await build({ engines: [{ kind: 'pi' }] }).router.create({
      workspace: { cwd: '/work/project', name: 'project' },
    });
    expect(plain.refreshHistory).toBeUndefined();
  });

  it('finds a session that appeared after the last scan with one forced refresh', async () => {
    // A child spawned mid-run is in the engine's listing before any scan has
    // read it; opening it must not be answered from a stale index window.
    const reported: AgentSessionInfo[] = [
      {
        sessionId: 'parent-engine',
        cwd: '/work/project',
        updatedAt: 1_000,
        messageCount: 1,
        token: '1',
      },
    ];
    let scans = 0;
    const { router, engines } = build({
      freshMs: 60_000, // The debounced read shares the first scan's result.
      engines: [
        {
          kind: 'opencode',
          gatewayFor: (input) => new FakeGateway(state({ sessionId: input.sessionId ?? '?' })),
          scan: () => {
            scans += 1;
            if (scans === 1) {
              return Promise.resolve(reported);
            }
            return Promise.resolve([
              ...reported,
              {
                sessionId: 'child-engine',
                cwd: '/work/project',
                updatedAt: 2_000,
                messageCount: 0,
                token: '2',
                parentSessionId: 'parent-engine',
                subagent: true,
              },
            ]);
          },
        },
      ],
    });
    await router.list(); // Warms the index without the child.

    const opened = await router.create({
      workspace: { cwd: '/work/project', name: 'project' },
      sessionId: recordOf('opencode', 'child-engine').id,
    });
    expect(scans).toBe(2);
    expect((await opened.state()).sessionId).toBe(recordOf('opencode', 'child-engine').id);
    expect(engines.get('opencode')?.created[0]?.sessionId).toBe('child-engine');
  });

  it('reports an id no engine holds instead of opening an arbitrary session', async () => {
    const { router, engines } = build({ engines: [{ kind: 'pi' }] });
    await expect(
      router.create({
        workspace: { cwd: '/work/project', name: 'project' },
        sessionId: 'not-indexed',
      }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(engines.get('pi')?.created).toEqual([]);
  });

  it('reports a session whose engine is not installed', async () => {
    const store = new MemoryStore();
    const record = recordOf('pi', 'pi-session-1');
    store.rows.set(record.id, record);
    const { router } = build({ store, engines: [{ kind: 'opencode' }] });
    await expect(router.create({ sessionId: record.id })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
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

/**
 * Which optional capabilities an engine's factory has decide what a host may
 * offer: a picker only advertises a config reload when the chosen engine can do
 * one, and the router is the only layer that knows which factory a draft means.
 */
describe('AgentRouter engine capabilities', () => {
  const WORKSPACE: WorkspaceRef = { cwd: '/work/project', name: 'project' };

  it('reports which engines can reload their config', () => {
    const store = new MemoryStore();
    const router = new AgentRouter({ store, defaultWorkspace: WORKSPACE, logger: silentLogger });
    const piEngine = new FakeEngine('pi', () => new FakeGateway(state({ sessionId: 'pi-new' })));
    const openCodeEngine = engineWithFactory(
      { reloadConfig: vi.fn(() => Promise.resolve()) },
      'opencode',
    );
    router.register(piEngine, { label: 'pi' });
    router.register(openCodeEngine, { label: 'OpenCode', default: true });

    expect(router.engineOptions()).toEqual([
      { kind: 'pi', label: 'pi' },
      { kind: 'opencode', label: 'OpenCode', default: true, reloadConfig: true },
    ]);
  });

  it('delegates configSignature and reloadConfig to the chosen engine', async () => {
    const signature = vi.fn(() => 'v1');
    const reload = vi.fn(() => Promise.resolve());
    const engine = engineWithFactory({ configSignature: signature, reloadConfig: reload });
    const store = new MemoryStore();
    const router = new AgentRouter({ store, defaultWorkspace: WORKSPACE, logger: silentLogger });
    router.register(engine, {});

    expect(router.configSignature({ workspace: WORKSPACE })).toBe('v1');
    await router.reloadConfig({ cwd: WORKSPACE.cwd });
    expect(reload).toHaveBeenCalledWith({ cwd: WORKSPACE.cwd });
  });

  it('forwards a draft mode to probeDefaults', async () => {
    const probeGateway = new FakeGateway(state({ sessionId: 'probe' }));
    const probe = vi.fn(() => Promise.resolve(probeGateway));
    const engine = engineWithFactory({ probeDefaults: probe });
    const store = new MemoryStore();
    const router = new AgentRouter({ store, defaultWorkspace: WORKSPACE, logger: silentLogger });
    router.register(engine, {});

    await router.probeDefaults({ workspace: WORKSPACE, mode: 'plan' });
    expect(probe).toHaveBeenCalledWith({ workspace: WORKSPACE, mode: 'plan' });
  });

  it('reports whether the config reload was delegated', async () => {
    const reload = vi.fn(() => Promise.resolve());
    const capable = new AgentRouter({
      store: new MemoryStore(),
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    capable.register(engineWithFactory({ reloadConfig: reload }));

    await expect(capable.reloadConfig({})).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // A factory without the capability, and a kind that is not installed, both
    // mean nothing was re-read — the caller must not report a success.
    const plain = new AgentRouter({
      store: new MemoryStore(),
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    plain.register(new FakeEngine('pi', () => new FakeGateway(state({ sessionId: 'pi-new' }))));
    await expect(plain.reloadConfig()).resolves.toBe(false);

    const empty = new AgentRouter({
      store: new MemoryStore(),
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    await expect(empty.reloadConfig({ engine: 'pi' })).resolves.toBe(false);
  });

  it('passes a config reload through to the wrapped gateway', async () => {
    const inner = new FakeGateway(state({ sessionId: 'parent-engine' }));
    let reloaded = 0;
    inner.refreshConfig = () => {
      reloaded += 1;
      return Promise.resolve();
    };
    const { router } = build({ engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({ workspace: WORKSPACE });
    await gateway.refreshConfig?.();
    expect(reloaded).toBe(1);
    // And a gateway whose adapter cannot reload simply reports no capability.
    const plain = await build({ engines: [{ kind: 'pi' }] }).router.create({
      workspace: WORKSPACE,
    });
    expect(plain.refreshConfig).toBeUndefined();
  });
});

describe('AgentRouter catalog', () => {
  function info(
    kind: string,
    sessionId: string,
    overrides: Partial<AgentSessionInfo> = {},
  ): AgentSessionInfo {
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

  it("lists both engines' sessions from the index, newest first, grouped by project cap", async () => {
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

  it("leaves an engine's rows alone when its scan fails, and still merges the other engine", async () => {
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
    expect(listed.map((session) => session.title).sort()).toEqual([
      'opencode new-one',
      'pi existing',
    ]);
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
        info('pi', `s${index}`, {
          title: index === 14 ? 'needle session' : `session ${index}`,
          updatedAt: 1_000 + index,
        }),
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

/**
 * Renaming and project deletion ride the same rule as the sidebar: the title is
 * Morse's once pinned, and a project's sessions are whatever the index holds for
 * that directory.
 */
describe('AgentRouter rename and project ids', () => {
  it('renames by writing the record with the pin and no engine token', async () => {
    const store = new MemoryStore();
    const record = recordOf('pi', 'pi-1');
    store.rows.set(record.id, record);
    const writes: Array<{ record: MorseSessionRecord; token?: string }> = [];
    const original = store.write.bind(store);
    store.write = async (next, token) => {
      writes.push({ record: next, token });
      await original(next, token);
    };
    const { router } = build({ store, engines: [] });

    await expect(router.rename(record.id, 'Release prep')).resolves.toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.record).toMatchObject({ title: 'Release prep', titlePinned: true });
    expect(writes[0]?.token).toBeUndefined();
  });

  it('reports a rename of a session the index no longer holds', async () => {
    const store = new MemoryStore();
    const writes: MorseSessionRecord[] = [];
    const original = store.write.bind(store);
    store.write = async (next, token) => {
      writes.push(next);
      await original(next, token);
    };
    const { router } = build({ store, engines: [] });

    await expect(router.rename('gone', 'x')).resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('leaves a pinned row alone when the engine renames itself', async () => {
    const store = new MemoryStore();
    const record = recordOf('pi', 'pi-1', { title: 'Release prep', titlePinned: true });
    store.rows.set(record.id, record);
    const inner = new FakeGateway(state({ sessionId: 'pi-1', sessionTitle: 'Release prep' }));
    const { router } = build({ store, engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({
      workspace: { cwd: '/work/project', name: 'project' },
      sessionId: record.id,
    });
    gateway.subscribe(() => undefined);
    inner.emit({
      type: 'agent/state',
      at: 2,
      state: state({ sessionId: 'pi-1', sessionTitle: 'Engine rename' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.rows.get(record.id)?.title).toBe('Release prep');
  });

  it('keeps the rename of a running session through its next report', async () => {
    const store = new MemoryStore();
    const record = recordOf('pi', 'pi-1', { title: 'Reply with exactly: pi-host' });
    store.rows.set(record.id, record);
    const inner = new FakeGateway(
      state({ sessionId: 'pi-1', sessionTitle: 'Reply with exactly: pi-host' }),
    );
    const { router } = build({ store, engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({
      workspace: { cwd: '/work/project', name: 'project' },
      sessionId: record.id,
    });
    gateway.subscribe(() => undefined);
    await gateway.state();
    await router.rename(record.id, 'Release prep');

    // The next report moves the count and names the session itself.
    inner.emit({
      type: 'agent/state',
      at: 3,
      state: state({
        sessionId: 'pi-1',
        sessionTitle: 'A brand new engine name',
        counts: {
          totalMessages: 4,
          userMessages: 2,
          assistantMessages: 2,
          toolCalls: 0,
          toolResults: 0,
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.rows.get(record.id)).toMatchObject({
      title: 'Release prep',
      titlePinned: true,
    });
  });

  it('lets the engine rename a row the reader never pinned', async () => {
    const store = new MemoryStore();
    const record = recordOf('pi', 'pi-1', { title: 'Derived from the first prompt' });
    store.rows.set(record.id, record);
    const inner = new FakeGateway(
      state({ sessionId: 'pi-1', sessionTitle: 'Derived from the first prompt' }),
    );
    const { router } = build({ store, engines: [{ kind: 'pi', gatewayFor: () => inner }] });

    const gateway = await router.create({
      workspace: { cwd: '/work/project', name: 'project' },
      sessionId: record.id,
    });
    gateway.subscribe(() => undefined);
    inner.emit({
      type: 'agent/state',
      at: 2,
      state: state({ sessionId: 'pi-1', sessionTitle: 'Engine rename' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.rows.get(record.id)?.title).toBe('Engine rename');
  });

  it('lists only the sessions of one project', async () => {
    const store = new MemoryStore();
    const here = recordOf('pi', 'pi-1');
    const elsewhere = recordOf('pi', 'pi-2', { cwd: '/work/other' });
    store.rows.set(here.id, here);
    store.rows.set(elsewhere.id, elsewhere);
    const { router } = build({ store, engines: [] });

    await expect(router.idsInProject('/work/project')).resolves.toEqual([here.id]);
  });
});
