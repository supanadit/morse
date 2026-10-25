import {
  SessionEngine,
  type AgentEvent,
  type AgentGateway,
  type AgentGatewayFactory,
  type AgentSessionState,
  type ModelRef,
  type WorkspaceRef,
} from '@morse/agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentUnavailableError } from '../errors.js';
import { silentLogger } from '../logger.js';
import type { SessionSummary } from '../domain/index.js';
import type { SessionCatalog } from './ports.js';
import { SessionRegistry } from './service.js';

/**
 * The registry owns the draft probe and the open path. What matters here: a
 * draft choice reaches the chosen engine (not the default one), and the probe
 * cache cannot hand one engine's model/mode catalog to another.
 */

const WORKSPACE: WorkspaceRef = { cwd: '/work/project', name: 'project' };

class FakeGateway implements AgentGateway {
  constructor(readonly current: AgentSessionState) {}

  subscribe(_listener: (event: AgentEvent) => void): () => void {
    return () => undefined;
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
  forkMessages(): Promise<never[]> {
    return Promise.resolve([]);
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
  readonly created: { workspace: WorkspaceRef; sessionId?: string; engine?: string; mode?: string }[] =
    [];
  readonly probed: { engine?: string; model?: ModelRef }[] = [];
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
      }),
    );
  }

  probeDefaults(input: { workspace: WorkspaceRef; engine?: string; model?: ModelRef }) {
    this.probed.push({
      ...(input.engine === undefined ? {} : { engine: input.engine }),
      ...(input.model === undefined ? {} : { model: input.model }),
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
      { engine: 'pi' },
      { engine: 'opencode' },
      { engine: 'opencode', model },
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
    expect(factory.probed).toEqual([{ engine: 'pi' }, { engine: 'pi' }]);
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
