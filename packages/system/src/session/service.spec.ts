import {
  SessionEngine,
  type AgentEvent,
  type AgentGateway,
  type AgentGatewayFactory,
  type AgentSessionState,
  type AgentUserMessage,
  type ModelRef,
  type WorkspaceRef,
} from '@morse/agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentUnavailableError, UnsupportedByHostError } from '../errors.js';
import { silentLogger } from '../logger.js';
import type { SessionSummary } from '../domain/index.js';
import type { SessionCatalog, SessionStore } from './ports.js';
import { AgentRouter } from './agent-router.js';
import { toSessionRecord, type MorseSessionRecord } from './record.js';
import { SessionRegistry } from './service.js';

/**
 * The registry owns the draft probe and the open path. What matters here: a
 * draft choice reaches the chosen engine (not the default one), and the probe
 * cache cannot hand one engine's model/mode catalog to another.
 */

const WORKSPACE: WorkspaceRef = { cwd: '/work/project', name: 'project' };

/** What a branch test steers: where a clone lands and what a rewrite drops. */
interface BranchBehaviour {
  /** The engine id a clone moves the session to. */
  cloneTo?: string;
  /** The dropped text a rewrite reports; unset makes it cancel. */
  rewriteText?: string;
  /**
   * The engine id a rewrite that branches lands on. Unset keeps the id (an
   * in-place edit); set moves it, like pi's rewrite which has no edit primitive.
   */
  rewriteTo?: string;
}

class FakeGateway implements AgentGateway {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  /** Present only when a test grants it, so the registry sees what an adapter would expose. */
  refreshConfig?: () => Promise<void>;

  constructor(
    public current: AgentSessionState,
    readonly kind = 'pi',
    private readonly branch: BranchBehaviour = {},
  ) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test-only: flips streaming and reports it, as an engine finishing a turn would. */
  setStreaming(streaming: boolean): void {
    this.current = { ...this.current, streaming };
    for (const listener of [...this.listeners]) {
      listener({ type: 'agent/state', at: Date.now(), state: { ...this.current } });
    }
  }
  state(): Promise<AgentSessionState> {
    return Promise.resolve({ ...this.current });
  }
  history(): Promise<{ entries: never[]; hasOlder: boolean }> {
    return Promise.resolve({ entries: [], hasOlder: false });
  }
  prompt(): Promise<'started'> {
    return Promise.resolve('started');
  }
  userMessages(): Promise<AgentUserMessage[]> {
    return Promise.resolve([]);
  }

  rewrite(): Promise<{ text: string; cancelled: boolean }> {
    if (this.branch.rewriteText === undefined) {
      return Promise.resolve({ text: '', cancelled: true });
    }
    // An in-place edit keeps the id; an engine that branches gets a new one.
    if (this.branch.rewriteTo !== undefined) {
      this.current = { ...this.current, sessionId: this.branch.rewriteTo };
    }
    return Promise.resolve({ text: this.branch.rewriteText, cancelled: false });
  }

  clone(): Promise<{ cancelled: boolean }> {
    const next = this.branch.cloneTo;
    if (next === undefined) {
      return Promise.resolve({ cancelled: true });
    }
    // A clone is a new session: the engine creates it and moves the agent there.
    this.current = { ...this.current, sessionId: next };
    return Promise.resolve({ cancelled: false });
  }
  fork(): Promise<{ text: string; cancelled: boolean }> {
    return Promise.resolve({ text: '', cancelled: true });
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

class FakeFactory implements AgentGatewayFactory {
  /** The config fingerprint `configSignature` reports; a test moves it to simulate an edit. */
  signature = 'v1';
  /** How many times the manual reload reached the engine. */
  reloads = 0;
  /** Whether this engine has a config to reload; false is an engine that has none. */
  canReload = true;

  /** The engine kind its gateways report, so a test can open a non-default one. */
  constructor(private readonly kind = 'pi') {}

  /** What a caller with no draft choice gets; the gateway kind is the same answer. */
  get defaultEngineKind(): string {
    return this.kind;
  }

  readonly created: { workspace: WorkspaceRef; sessionId?: string; engine?: string; mode?: string }[] =
    [];
  readonly probed: { engine?: string; model?: ModelRef; mode?: string; workspace?: string }[] = [];
  private next = 0;

  create(input: { workspace: WorkspaceRef; sessionId?: string; engine?: string; mode?: string }) {
    this.created.push(input);
    this.next += 1;
    return Promise.resolve(
      new FakeGateway({
        sessionId: `session-${this.next}`,
        workspace: input.workspace,
        thinkingLevel: 'off',
        availableModels: [],
        availableThinkingLevels: [],
        availableCommands: [],
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        streaming: false,
      }, this.kind),
    );
  }

  probeDefaults(input: {
    workspace: WorkspaceRef;
    engine?: string;
    model?: ModelRef;
    mode?: string;
  }) {
    this.probed.push({
      ...(input.engine === undefined ? {} : { engine: input.engine }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      workspace: input.workspace.cwd,
    });
    return Promise.resolve(
      new FakeGateway({
        workspace: input.workspace,
        thinkingLevel: 'off',
        availableModels: [],
        availableThinkingLevels: [],
        availableCommands: [],
        mode: `${input.engine ?? 'default'}:${input.model?.id ?? 'none'}`,
        streaming: false,
      }),
    );
  }

  configSignature(): string {
    return this.signature;
  }

  reloadConfig(): Promise<boolean> {
    if (!this.canReload) {
      return Promise.resolve(false);
    }
    this.reloads += 1;
    return Promise.resolve(true);
  }
}

const emptyCatalog: SessionCatalog = {
  list: (): Promise<SessionSummary[]> => Promise.resolve([]),
};

function registry(factory: FakeFactory): SessionRegistry {
  return new SessionRegistry({
    factory,
    catalog: emptyCatalog,
    defaultWorkspace: WORKSPACE,
    logger: silentLogger,
    engines: [engineOf('pi'), engineOf('opencode')],
  });
}

function engineOf(kind: string): SessionEngine {
  return {
    kind,
    factory: new FakeFactory(),
  } as unknown as SessionEngine;
}

/** The id a branch test's session holds before a branch moves it. */
const PRE_BRANCH_SESSION_ID = 'start-session';

/**
 * The gateway the branch tests drive. `sessionId` is the new session a clone (or
 * a branching rewrite) lands on; `startsAt` is the id the session begins with —
 * a rewrite that edits in place keeps it, so only `rewriteText` applies there.
 */
function fakeGateway(options: {
  sessionId: string;
  startsAt?: string;
  rewriteText?: string;
  rewriteTo?: string;
}): FakeGateway {
  return new FakeGateway(
    {
      sessionId: options.startsAt ?? PRE_BRANCH_SESSION_ID,
      workspace: WORKSPACE,
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
    },
    'pi',
    {
      cloneTo: options.sessionId,
      ...(options.rewriteText === undefined ? {} : { rewriteText: options.rewriteText }),
      ...(options.rewriteTo === undefined ? {} : { rewriteTo: options.rewriteTo }),
    },
  );
}

/** A registry with each gateway opened in turn, so the last one is the active session. */
async function makeRegistryOf(...gateways: AgentGateway[]): Promise<SessionRegistry> {
  const queue = [...gateways];
  const factory: AgentGatewayFactory = {
    create: () => Promise.resolve(queue.shift() as AgentGateway),
  };
  const sessions = new SessionRegistry({
    factory,
    catalog: emptyCatalog,
    defaultWorkspace: WORKSPACE,
    logger: silentLogger,
  });
  for (let i = 0; i < gateways.length; i += 1) {
    await sessions.open();
  }
  return sessions;
}

/** A registry with `gateway` as its one hot, active session — what a branch needs. */
function makeRegistry(gateway: AgentGateway): Promise<SessionRegistry> {
  return makeRegistryOf(gateway);
}

describe('SessionRegistry draft engine', () => {
  it('opens a new session through the chosen engine and mode', async () => {
    const factory = new FakeFactory();
    const sessions = registry(factory);

    await sessions.open({ engine: 'opencode', mode: 'plan' });

    expect(factory.created).toEqual([
      { workspace: WORKSPACE, engine: 'opencode', mode: 'plan' },
    ]);
    expect(sessions.engineKinds()).toEqual(['pi', 'opencode']);
  });

  it('keeps each engine and model in its own draft cache entry', async () => {
    const factory = new FakeFactory();
    const sessions = registry(factory);
    const model: ModelRef = { provider: 'opencode', id: 'deepseek' };

    const pi = await sessions.draftDefaults('pi');
    const openCode = await sessions.draftDefaults('opencode');
    const openCodeModel = await sessions.draftDefaults('opencode', model);
    // Asking again is served from the cache.
    await sessions.draftDefaults('opencode', model);

    expect(pi?.mode).toBe('pi:none');
    expect(openCode?.mode).toBe('opencode:none');
    expect(openCodeModel?.mode).toBe('opencode:deepseek');
    expect(factory.probed).toEqual([
      { engine: 'pi', workspace: WORKSPACE.cwd },
      { engine: 'opencode', workspace: WORKSPACE.cwd },
      { engine: 'opencode', model, workspace: WORKSPACE.cwd },
    ]);
    expect(sessions.cachedDraftDefaults('opencode')).toBe(openCode);
    expect(sessions.cachedDraftDefaults('opencode', model)).toBe(openCodeModel);
    expect(sessions.cachedDraftDefaults('pi')).toBe(pi);
  });

  it('forgets every draft cache entry when the catalog is refreshed', async () => {
    const factory = new FakeFactory();
    const sessions = registry(factory);
    await sessions.draftDefaults('pi');
    sessions.refreshDraftDefaults();
    await sessions.draftDefaults('pi');
    expect(factory.probed).toEqual([
      { engine: 'pi', workspace: WORKSPACE.cwd },
      { engine: 'pi', workspace: WORKSPACE.cwd },
    ]);
  });

  it('does not memoise a probe that throws', async () => {
    const factory = new FakeFactory();
    const failing = vi
      .spyOn(factory, 'probeDefaults')
      .mockRejectedValueOnce(new AgentUnavailableError('no server'))
      .mockResolvedValueOnce(
        new FakeGateway({
          workspace: WORKSPACE,
          thinkingLevel: 'off',
          availableModels: [],
          availableThinkingLevels: [],
          availableCommands: [],
          streaming: false,
        }),
      );
    const sessions = registry(factory);

    await expect(sessions.draftDefaults('opencode')).rejects.toThrow('no server');
    await expect(sessions.draftDefaults('opencode')).resolves.toBeDefined();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

/**
 * A draft's catalogs depend on more than the engine and model: the mode decides
 * the effective agent, the project decides which config files are read, and an
 * edit to those files invalidates what the last probe read.
 */
describe('SessionRegistry draft freshness', () => {
  it('keys a draft probe by mode, project and config signature', async () => {
    const factory = new FakeFactory();
    const sessions = registry(factory);
    const a = await sessions.draftDefaults('opencode', undefined, 'build', WORKSPACE);
    await sessions.draftDefaults('opencode', undefined, 'plan', WORKSPACE);
    await sessions.draftDefaults('opencode', undefined, 'build', {
      cwd: '/work/other',
      name: 'other',
    });
    expect(factory.probed).toHaveLength(3);
    factory.signature = 'v2';
    await sessions.draftDefaults('opencode', undefined, 'build', WORKSPACE);
    expect(factory.probed).toHaveLength(4);
    expect(a?.mode).toBe('opencode:none');
  });

  it('probes the drafted project, not the host default', async () => {
    const factory = new FakeFactory();
    const sessions = registry(factory);
    await sessions.draftDefaults('opencode', undefined, 'build', {
      cwd: '/work/other',
      name: 'other',
    });
    expect(factory.probed.at(-1)?.workspace).toBe('/work/other');
  });

  it('drops a cached draft when the config signature changes', async () => {
    const factory = new FakeFactory();
    const sessions = registry(factory);
    await sessions.draftDefaults('opencode');
    expect(sessions.cachedDraftDefaults('opencode')).toBeDefined();
    factory.signature = 'v2';
    expect(sessions.cachedDraftDefaults('opencode')).toBeUndefined();
  });
});

/**
 * Reloading an engine's configuration is a manual control: it must refuse to
 * yank the config out from under a running turn unless the reader insists, and
 * it must only speak for the engine it names.
 */
describe('SessionRegistry reloadAgentConfig', () => {
  it('warns before reloading while that engine streams, then reloads on force', async () => {
    const factory = new FakeFactory('opencode');
    const sessions = registry(factory);
    const opened = await sessions.open({ engine: 'opencode' });
    (sessions.agentFor(opened.key) as FakeGateway).setStreaming(true);
    await expect(sessions.reloadAgentConfig({ engine: 'opencode' })).resolves.toEqual({
      reloaded: false,
      requiresConfirmation: true,
      running: 1,
    });
    expect(factory.reloads).toBe(0);
    await expect(sessions.reloadAgentConfig({ engine: 'opencode', force: true })).resolves.toEqual({
      reloaded: true,
      running: 1,
    });
    expect(factory.reloads).toBe(1);
  });

  it('falls back to the factory’s default engine when none is named', async () => {
    const factory = new FakeFactory('opencode');
    const sessions = registry(factory);
    const opened = await sessions.open({ engine: 'opencode' });
    (sessions.agentFor(opened.key) as FakeGateway).setStreaming(true);

    await expect(sessions.reloadAgentConfig()).resolves.toEqual({
      reloaded: false,
      requiresConfirmation: true,
      running: 1,
    });
  });

  it('does not count another engine’s running turn against the reload', async () => {
    const factory = new FakeFactory('pi');
    const sessions = registry(factory);
    const opened = await sessions.open({ engine: 'pi' });
    const pi = sessions.agentFor(opened.key) as FakeGateway;
    pi.setStreaming(true);
    const refresh = vi.fn(() => Promise.resolve());
    pi.refreshConfig = refresh;

    await expect(sessions.reloadAgentConfig({ engine: 'opencode' })).resolves.toEqual({
      reloaded: true,
      running: 0,
    });
    expect(factory.reloads).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes the warm gateways of the reloaded engine', async () => {
    const factory = new FakeFactory('opencode');
    const sessions = registry(factory);
    const opened = await sessions.open({ engine: 'opencode' });
    const gateway = sessions.agentFor(opened.key) as FakeGateway;
    const refresh = vi.fn(() => Promise.resolve());
    gateway.refreshConfig = refresh;

    await expect(sessions.reloadAgentConfig({ engine: 'opencode' })).resolves.toEqual({
      reloaded: true,
      running: 0,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the reload working when a warm gateway cannot refresh its config', async () => {
    const factory = new FakeFactory('opencode');
    const sessions = registry(factory);
    const opened = await sessions.open({ engine: 'opencode' });
    const gateway = sessions.agentFor(opened.key) as FakeGateway;
    gateway.refreshConfig = vi.fn(() => Promise.reject(new Error('boom')));

    await expect(sessions.reloadAgentConfig({ engine: 'opencode' })).resolves.toEqual({
      reloaded: true,
      running: 0,
    });
    expect(factory.reloads).toBe(1);
  });

  it('reports a reload the engine cannot perform without touching its caches', async () => {
    const factory = new FakeFactory('pi');
    factory.canReload = false;
    const sessions = registry(factory);
    await sessions.draftDefaults('pi');
    expect(factory.probed).toHaveLength(1);
    const opened = await sessions.open({ engine: 'pi' });
    const gateway = sessions.agentFor(opened.key) as FakeGateway;
    const refresh = vi.fn(() => Promise.resolve());
    gateway.refreshConfig = refresh;

    await expect(sessions.reloadAgentConfig({ engine: 'pi' })).resolves.toEqual({
      reloaded: false,
      running: 0,
    });
    expect(factory.reloads).toBe(0);
    // Nothing was re-read, so no warm session is told to re-read and the cached
    // draft still answers the next probe.
    expect(refresh).not.toHaveBeenCalled();
    await sessions.draftDefaults('pi');
    expect(factory.probed).toHaveLength(1);
  });

  it('clears the draft caches so the next probe reads the reloaded config', async () => {
    const factory = new FakeFactory('opencode');
    const sessions = registry(factory);
    await sessions.draftDefaults('opencode');
    expect(factory.probed).toHaveLength(1);

    await sessions.reloadAgentConfig({ engine: 'opencode' });
    await sessions.draftDefaults('opencode');

    expect(factory.probed).toHaveLength(2);
  });
});

describe('SessionRegistry engineOf', () => {
  it('names the engine that owns a hot session', async () => {
    const sessions = registry(new FakeFactory('opencode'));
    const opened = await sessions.open({ engine: 'opencode' });
    expect(sessions.engineOf(opened.key)).toBe('opencode');
  });

  it('reports nothing for a key it never opened', () => {
    expect(registry(new FakeFactory()).engineOf('derived-id-nobody-opened')).toBeUndefined();
  });

  it('reports nothing once the session is closed', async () => {
    const sessions = registry(new FakeFactory());
    const opened = await sessions.open();
    expect(sessions.engineOf(opened.key)).toBe('pi');
    await sessions.close(opened.key);
    expect(sessions.engineOf(opened.key)).toBeUndefined();
  });
});

/**
 * The use cases around the catalog's newer verbs: a rename reaches the index
 * (never an engine), and a project delete is the session delete run over every
 * row a directory holds — close first, then remove, and one failure never stops
 * the rest.
 */
describe('SessionRegistry rename and project delete', () => {
  function withCatalog(catalog: SessionCatalog): SessionRegistry {
    return new SessionRegistry({
      factory: new FakeFactory(),
      catalog,
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
  }

  it('renames through the catalog and reports an unknown session', async () => {
    const rename = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const sessions = withCatalog({ list: () => Promise.resolve([]), rename });

    await expect(sessions.renameSession('s1', 'Release prep')).resolves.toBe(true);
    await expect(sessions.renameSession('s2', 'x')).resolves.toBe(false);
    expect(rename.mock.calls).toEqual([
      ['s1', 'Release prep'],
      ['s2', 'x'],
    ]);
  });

  it('refuses a rename when the catalog cannot rename', async () => {
    const sessions = withCatalog({ list: () => Promise.resolve([]) });

    await expect(sessions.renameSession('s1', 'x')).rejects.toBeInstanceOf(
      UnsupportedByHostError,
    );
  });

  it('deletes a project’s sessions after closing each live one', async () => {
    const order: string[] = [];
    const sessions = withCatalog({
      list: () => Promise.resolve([]),
      idsInProject: () => Promise.resolve(['a', 'b']),
      remove: (id) => {
        order.push(`remove:${id}`);
        return Promise.resolve();
      },
    });
    vi.spyOn(sessions, 'close').mockImplementation(async (key) => {
      order.push(`close:${key}`);
    });

    await expect(sessions.deleteProject('/work/morse')).resolves.toEqual({
      deleted: ['a', 'b'],
      failed: [],
    });
    expect(order).toEqual(['close:a', 'remove:a', 'close:b', 'remove:b']);
  });

  it('reports the sessions it could not delete and keeps going', async () => {
    const sessions = withCatalog({
      list: () => Promise.resolve([]),
      idsInProject: () => Promise.resolve(['a', 'b', 'c']),
      remove: (id) =>
        id === 'b' ? Promise.reject(new Error('refused')) : Promise.resolve(),
    });
    vi.spyOn(sessions, 'close').mockResolvedValue(undefined);

    await expect(sessions.deleteProject('/work/morse')).resolves.toEqual({
      deleted: ['a', 'c'],
      failed: ['b'],
    });
  });

  it('deletes a project’s sessions through each owning engine', async () => {
    // The router is the real catalog here: it must send each record to the
    // engine that owns it, never to whichever engine happens to be first.
    const rows = new Map<string, MorseSessionRecord>();
    const record = (kind: string, id: string): MorseSessionRecord => {
      const row = toSessionRecord(kind, {
        sessionId: id,
        cwd: '/work/morse',
        updatedAt: 1,
        messageCount: 1,
        token: 't',
      });
      rows.set(row.id, row);
      return row;
    };
    const pi = record('pi', 'pi-1');
    const opencode = record('opencode', 'oc-1');
    const removed: Record<string, string[]> = { pi: [], opencode: [] };
    const store: SessionStore = {
      list: () => Promise.resolve([...rows.values()]),
      read: (id) => Promise.resolve(rows.get(id)),
      write: (row) => {
        rows.set(row.id, row);
        return Promise.resolve();
      },
      remove: (id) => {
        rows.delete(id);
        return Promise.resolve();
      },
    };
    const engineOf = (kind: 'pi' | 'opencode'): SessionEngine =>
      ({
        kind,
        factory: new FakeFactory(kind),
        catalog: {
          list: () => Promise.resolve([]),
          remove: (id: string) => {
            removed[kind]?.push(id);
            return Promise.resolve();
          },
        },
      }) as unknown as SessionEngine;
    const router = new AgentRouter({
      store,
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
      freshMs: 0,
    });
    const piEngine = engineOf('pi');
    const openCodeEngine = engineOf('opencode');
    router.register(piEngine, { catalog: piEngine.catalog });
    router.register(openCodeEngine, { catalog: openCodeEngine.catalog });
    const sessions = new SessionRegistry({
      factory: new FakeFactory(),
      catalog: router,
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });

    await expect(sessions.deleteProject('/work/morse')).resolves.toEqual({
      deleted: [pi.id, opencode.id],
      failed: [],
    });

    expect(removed.pi).toEqual([pi.engineRef.sessionId]);
    expect(removed.opencode).toEqual([opencode.engineRef.sessionId]);
    expect([...rows.keys()]).toEqual([]);
  });

  it('refuses a project delete when the catalog cannot list one', async () => {
    const sessions = withCatalog({ list: () => Promise.resolve([]) });

    await expect(sessions.deleteProject('/work/morse')).rejects.toBeInstanceOf(
      UnsupportedByHostError,
    );
  });
});

/**
 * A branch is one operation with three names: a fork cuts before a message, a
 * rewrite edits one (in place when the engine can, by branching when it cannot),
 * and a clone branches at the tip. All three re-key the hot entry the same way,
 * and only a branch of the host-wide session in front adopts the new key — a
 * pinned tab branching its own conversation must not steal the sidebar's pointer.
 */
describe('SessionRegistry branch operations', () => {
  it('keeps the key when the engine rewrote in place', async () => {
    const gateway = fakeGateway({ sessionId: 'same', rewriteText: 'old prompt' });
    const registry = await makeRegistry(gateway);
    const result = await registry.rewriteActive('entry-1');
    expect(result.key).toBe(result.previousKey);
    expect(result.text).toBe('old prompt');
    expect(result.cancelled).toBe(false);
  });

  it('re-keys when the engine cloned onto a new session', async () => {
    const gateway = fakeGateway({ sessionId: 'next-session' });
    const registry = await makeRegistry(gateway);
    const result = await registry.cloneActive();
    expect(result.previousKey).not.toBe(result.key);
    expect(result.key).toBe('next-session');
    expect(registry.activeKeyOf()).toBe('next-session');
  });

  it('re-keys a pinned tab’s rewrite without stealing the active pointer', async () => {
    // Only a rewrite that branches moves the key, so the pinned path is driven
    // with one: pi has no edit primitive and always lands on a new session.
    const pinned = fakeGateway({
      startsAt: 'pinned-session',
      sessionId: 'unused-clone',
      rewriteText: 'old prompt',
      rewriteTo: 'pinned-branch',
    });
    const front = fakeGateway({ startsAt: 'front-session', sessionId: 'unused-clone' });
    const registry = await makeRegistryOf(pinned, front);

    const result = await registry.rewriteActive('entry-1', 'pinned-session');

    expect(result.previousKey).toBe('pinned-session');
    expect(result.key).toBe('pinned-branch');
    expect(registry.hotKeys()).toContain('pinned-branch');
    expect(registry.hotKeys()).not.toContain('pinned-session');
    // The tab followed its own conversation; the host's session in front did not.
    expect(registry.activeKeyOf()).toBe('front-session');
  });

  it('adopts a rewrite that moved the key when no session was pinned', async () => {
    const gateway = fakeGateway({
      sessionId: 'unused-clone',
      rewriteText: 'old prompt',
      rewriteTo: 'next-session',
    });
    const registry = await makeRegistry(gateway);

    const result = await registry.rewriteActive('entry-1');

    expect(result.key).toBe('next-session');
    expect(registry.activeKeyOf()).toBe('next-session');
  });

  it('re-keys a pinned tab’s clone without stealing the active pointer', async () => {
    const pinned = fakeGateway({ startsAt: 'pinned-session', sessionId: 'pinned-clone' });
    const front = fakeGateway({ startsAt: 'front-session', sessionId: 'front-clone' });
    const registry = await makeRegistryOf(pinned, front);

    const result = await registry.cloneActive('pinned-session');

    expect(result.previousKey).toBe('pinned-session');
    expect(result.key).toBe('pinned-clone');
    expect(registry.hotKeys()).not.toContain('pinned-session');
    expect(registry.activeKeyOf()).toBe('front-session');
  });
});
