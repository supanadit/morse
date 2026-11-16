import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AgentSessionState, ModelRef } from '@morse/agent';
import type { ConfigMutation } from '@morse/engine-config';
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

/**
 * Every engine in this file fingerprints this directory, never the host's real
 * config, so no test reads — or collects a reload from — the machine's own
 * `opencode.json`.
 */
const tempConfigDir = mkdtempSync(join(tmpdir(), 'oc-engine-config-'));
writeFileSync(join(tempConfigDir, 'opencode.json'), '{}\n', 'utf8');

afterAll(() => {
  rmSync(tempConfigDir, { recursive: true, force: true });
});

const FLINT: ApiModel = {
  id: 'flint-40b-free',
  providerID: 'opencode-go',
  name: 'Flint 40B Free',
  variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
  limit: { context: 100_000, output: 8_000 },
  capabilities: { input: ['text'] },
};

const QWEN: ApiModel = {
  id: 'qwen4-max',
  providerID: 'opencode-go',
  name: 'Qwen4 Max',
  limit: { context: 200_000, output: 16_000 },
  capabilities: { input: ['text'] },
};

/** The model `/api/agent` reports for `plan`. */
const PLAN_AGENT_MODEL = { id: FLINT.id, providerID: FLINT.providerID };

/**
 * The model `/api/agent` reports for `build`, the configured default agent. It
 * is deliberately different from `/api/model/default`: that endpoint is not
 * agent-aware, so a draft naming Qwen4 Max proves the agent's model won.
 */
const BUILD_AGENT_MODEL = { id: QWEN.id, providerID: QWEN.providerID };

interface AgentModelRow {
  id: string;
  providerID: string;
  variant?: string;
}

interface SessionRow {
  id: string;
  title?: string;
  time?: { created?: number; updated?: number };
  location?: { directory?: string };
  outcome?: string;
  fork?: { sessionID?: string };
}

interface FakeApiOptions {
  sessions: SessionRow[];
  /** `/api/model`'s answer. */
  models: ApiModel[];
  /** `/api/agent`'s model for `build`; `undefined` means it names none. */
  agentModel: AgentModelRow | undefined;
  /** `/api/model/default`'s answer; `undefined` means the endpoint names none. */
  defaultModel: ApiModel | undefined;
  /** Makes `POST /location/reload` fail, as a 500 or a timeout would. */
  reloadError?: Error;
}

class FakeApi {
  readonly calls: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
    params?: Record<string, string>;
  }[] = [];

  constructor(private readonly options: FakeApiOptions) {}

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    this.calls.push({ method: 'GET', path, ...(params === undefined ? {} : { params }) });
    if (path === '/model') {
      return Promise.resolve(this.options.models as unknown as T);
    }
    if (path === '/command') {
      return Promise.resolve([{ name: 'init', description: 'setup' }] as unknown as T);
    }
    if (path === '/skill') {
      return Promise.resolve([
        { id: 'opencode', name: 'OpenCode', description: 'about it' },
      ] as unknown as T);
    }
    if (path === '/agent') {
      return Promise.resolve([
        {
          id: 'build',
          name: 'Build',
          mode: 'primary',
          hidden: false,
          ...(this.options.agentModel === undefined ? {} : { model: this.options.agentModel }),
        },
        {
          id: 'plan',
          name: 'Plan',
          mode: 'primary',
          hidden: false,
          model: PLAN_AGENT_MODEL,
        },
        { id: 'general', name: 'General', mode: 'subagent', hidden: false },
      ] as unknown as T);
    }
    if (path === '/config') {
      return Promise.resolve([
        { type: 'document', info: { default_agent: 'build' } },
      ] as unknown as T);
    }
    if (path === '/model/default') {
      return Promise.resolve((this.options.defaultModel ?? null) as unknown as T);
    }
    const id = path.split('/')[2];
    const session = this.options.sessions.find((row) => row.id === id);
    return session === undefined
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(session as unknown as T);
  }

  page<T>(path: string): Promise<OpenCodePage<T>> {
    this.calls.push({ method: 'GET', path });
    return Promise.resolve({ data: this.options.sessions as unknown as T[] });
  }

  post<T>(path: string, body?: unknown): Promise<T | undefined> {
    this.calls.push({ method: 'POST', path, body });
    if (path === '/location/reload' && this.options.reloadError !== undefined) {
      return Promise.reject(this.options.reloadError);
    }
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

function engineWith(
  options: {
    sessions?: SessionRow[];
    owned?: boolean;
    /** The config dir its agents read global command templates from. */
    configDir?: string;
    /** Replaces `/api/model`'s answer. */
    models?: ApiModel[];
    /** `/api/model/default`'s answer; present-but-undefined means it names none. */
    defaultModel?: ApiModel;
    /** `/api/agent`'s model for `build`; present-but-undefined means it names none. */
    agentModel?: AgentModelRow;
    /** Makes `POST /location/reload` fail, as a 500 or a timeout would. */
    reloadError?: Error;
  } = {},
): {
  engine: OpenCodeEngine;
  api: FakeApi;
  closed: { stream: ReturnType<typeof vi.fn>; connection: ReturnType<typeof vi.fn> };
  /** Rewrites the config file and bumps its fingerprint, as an editor would. */
  touchConfig: () => void;
} {
  const configDir = options.configDir ?? tempConfigDir;
  const api = new FakeApi({
    sessions: options.sessions ?? [
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
    models: options.models ?? [FLINT, QWEN],
    // `in`, not `??`: a test that passes the option explicitly wants "no model",
    // which is exactly the state a server without a fallback leaves.
    agentModel: 'agentModel' in options ? options.agentModel : BUILD_AGENT_MODEL,
    defaultModel: 'defaultModel' in options ? options.defaultModel : FLINT,
    ...(options.reloadError === undefined ? {} : { reloadError: options.reloadError }),
  });
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
    configDir,
  });
  let touched = 0;
  const touchConfig = (): void => {
    touched += 1;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'opencode.json'), `{\n  "touched": ${touched}\n}\n`, 'utf8');
  };
  return { engine, api, closed, touchConfig };
}

describe('OpenCodeEngine', () => {
  it("reports the server's sessions in the engine's own terms", async () => {
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
    const createCall = api.calls.find((call) => call.method === 'POST' && call.path === '/session');
    expect(createCall?.body).toEqual({ location: { directory: WORKSPACE.cwd } });
    expect((await created.state()).sessionId).toBe('ses_new');
    await created.dispose();

    const planned = await engine.factory.create({ workspace: WORKSPACE, mode: 'plan' });
    const plannedCall = api.calls
      .filter((call) => call.method === 'POST' && call.path === '/session')
      .at(-1);
    expect(plannedCall?.body).toEqual({ location: { directory: WORKSPACE.cwd }, agent: 'plan' });
    await planned.dispose();

    const resumed = await engine.factory.create({ workspace: WORKSPACE, sessionId: 'ses_1' });
    expect(api.calls.some((call) => call.method === 'GET' && call.path === '/session/ses_1')).toBe(
      true,
    );
    expect((await resumed.state()).sessionId).toBe('ses_1');
    await resumed.dispose();
  });

  it('probes the catalogs without creating a session', async () => {
    const { engine, api } = engineWith({ sessions: [] });
    const probe = await engine.factory.probeDefaults({ workspace: WORKSPACE });
    const state = await probe.state();

    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([]);
    expect(api.calls.map((call) => call.path).sort()).toEqual([
      '/agent',
      '/command',
      '/config',
      '/model',
      '/model/default',
      '/skill',
    ]);
    expect(state.availableModels).toHaveLength(2);
    expect(state.availableCommands.map((command) => command.name)).toEqual(['init', 'OpenCode']);
    // The draft names the model the default agent is configured to run, which is
    // what the first prompt will actually use.
    expect(state.model).toMatchObject({ provider: 'opencode-go', id: 'qwen4-max' });
    expect(state.availableThinkingLevels).toEqual([]);
    expect(state.mode).toBe('build');
    expect(state.availableModes?.map((mode) => mode.id)).toEqual(['build', 'plan']);
    expect(state.availableModes?.find((mode) => mode.id === 'build')?.default).toBe(true);

    await probe.dispose();
    // A draft refuses what it cannot do instead of pretending.
    await expect(probe.prompt('hi', 'new')).rejects.toBeInstanceOf(UnsupportedByHostError);
  });

  it("names the default agent's configured model in a draft", async () => {
    const { engine, api } = engineWith();
    const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
    expect(state.model).toMatchObject({ provider: 'opencode-go', id: 'qwen4-max' });
    // Every catalog read names the drafted workspace, so a project's own config
    // decides the answer.
    const modelCall = api.calls.find((call) => call.path === '/model');
    expect(modelCall?.params).toEqual({ 'location[directory]': WORKSPACE.cwd });
  });

  it("names the picked mode's model in a draft", async () => {
    const { engine } = engineWith();
    const state = await (
      await engine.factory.probeDefaults({ workspace: WORKSPACE, mode: 'plan' })
    ).state();
    expect(state.model).toMatchObject({ provider: 'opencode-go', id: 'flint-40b-free' });
    expect(state.mode).toBe('plan');
  });

  it('keeps an explicitly picked model over any agent default', async () => {
    const { engine } = engineWith();
    const model: ModelRef = {
      provider: 'opencode-go',
      id: 'flint-40b-free',
      name: 'Flint',
    };
    const state = await (
      await engine.factory.probeDefaults({ workspace: WORKSPACE, model, mode: 'build' })
    ).state();
    expect(state.model).toMatchObject({ id: 'flint-40b-free' });
  });

  it('uses the server fallback when the agent model is not in the catalog', async () => {
    const { engine } = engineWith({ agentModel: { id: 'missing', providerID: 'opencode-go' } });
    const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
    expect(state.model).toMatchObject({ id: 'flint-40b-free' });
  });

  it('reports no model when neither the agent nor the fallback resolves', async () => {
    const { engine } = engineWith({ models: [], defaultModel: undefined });
    const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
    expect(state.model).toBeUndefined();
  });

  it('reloads the location before a probe when the config signature changed', async () => {
    const { engine, api, touchConfig } = engineWith({ owned: true, configDir: tempConfigDir });
    // The first probe seeds the signature; no reload yet.
    await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
    expect(api.calls.map((call) => call.path)).not.toContain('/location/reload');

    touchConfig(); // writes the config or bumps its mtime
    await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
    const paths = api.calls.map((call) => call.path);
    expect(paths).toContain('/location/reload');
    expect(paths.lastIndexOf('/location/reload')).toBeLessThan(paths.lastIndexOf('/model'));
  });

  it('reloads the config on demand', async () => {
    const { engine } = engineWith();
    await expect(engine.factory.reloadConfig({ cwd: WORKSPACE.cwd })).resolves.toBe(true);
  });

  it('rejects a manual reload the server refused', async () => {
    const { engine } = engineWith({ reloadError: new Error('the server answered 500') });
    await expect(engine.factory.reloadConfig({ cwd: WORKSPACE.cwd })).rejects.toThrow(
      /could not reload its config/i,
    );
  });

  it("watches the drafted project's config, not only the global one", async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-engine-project-'));
    try {
      const project = join(root, 'project');
      const configDir = join(root, 'config');
      const projectConfig = join(project, '.opencode', 'opencode.json');
      mkdirSync(join(project, '.opencode'), { recursive: true });
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'opencode.json'), '{}\n', 'utf8');
      writeFileSync(projectConfig, '{"default_agent":"build"}\n', 'utf8');
      const { engine, api } = engineWith({ owned: true, configDir });
      const workspace = { cwd: project, name: 'project' };

      // The first probe only seeds: the server already started from these files.
      await (await engine.factory.probeDefaults({ workspace })).state();
      expect(api.calls.map((call) => call.path)).not.toContain('/location/reload');

      // The project file is part of the fingerprint, so editing it is the change
      // the next probe acts on — a project's own config reaches its draft.
      writeFileSync(projectConfig, '{"default_agent":"plan"}\n', 'utf8');
      const state = await (await engine.factory.probeDefaults({ workspace })).state();
      expect(api.calls.map((call) => call.path)).toContain('/location/reload');
      // Every catalog read names the drafted project, which is what decides it.
      expect(api.calls.filter((call) => call.path === '/model').at(-1)?.params).toEqual({
        'location[directory]': project,
      });
      expect(state.workspace).toEqual(workspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a bot's command templates from its own config dir, not the host's XDG one", async () => {
    // A bot's engine is handed `<botRoot>/config/opencode`; the decoy stands in
    // for the host's XDG config, so a template resolved there would prove the
    // leak this pins shut.
    const root = mkdtempSync(join(tmpdir(), 'oc-engine-bot-'));
    try {
      const decoy = join(root, 'host');
      const botConfigDir = join(root, 'bot', 'config', 'opencode');
      for (const [base, body] of [
        [join(decoy, 'opencode'), 'Host body for $1.'],
        [botConfigDir, 'Bot body for $1.'],
      ] as const) {
        mkdirSync(join(base, 'commands'), { recursive: true });
        writeFileSync(join(base, 'commands', 'init.md'), body, 'utf8');
      }
      vi.stubEnv('XDG_CONFIG_HOME', decoy);
      try {
        const { engine } = engineWith({ sessions: [], configDir: botConfigDir });
        const probe = await engine.factory.probeDefaults({ workspace: WORKSPACE });
        const state = await probe.state();

        expect(state.availableCommands.find((command) => command.name === 'init')?.template).toBe(
          'Bot body for $1.',
        );
        await probe.dispose();
      } finally {
        vi.unstubAllEnvs();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("offers the picked model's levels on a probe", async () => {
    const { engine } = engineWith({ sessions: [] });
    const model: ModelRef = { provider: 'opencode-go', id: 'flint-40b-free', name: 'Flint 40B Free' };
    const probe = await engine.factory.probeDefaults({ workspace: WORKSPACE, model });
    const state: AgentSessionState = await probe.state();
    expect(state.model).toMatchObject({ provider: 'opencode-go', id: 'flint-40b-free' });
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

  it('fixes only the config path the engine resolves, never an arbitrary file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-engine-fix-'));
    try {
      const configDir = join(root, 'opencode');
      mkdirSync(configDir, { recursive: true });
      const file = join(configDir, 'opencode.json');
      writeFileSync(file, '{\n  // dropped by a fix\n  "mcp": {}\n}\n', 'utf8');
      const { engine } = engineWith({ sessions: [], configDir });

      const fixed = (await engine.extras.fix?.({
        fileId: 'config',
        path: file,
        scope: 'global',
      })) as ConfigMutation;
      expect(fixed).toMatchObject({ ok: true, path: file, scope: 'global' });
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('//');
      expect(JSON.parse(text)).toEqual({ mcp: {} });

      // A file beside it is not one of OpenCode's config paths, so Fix refuses
      // it instead of normalising a file the reader never asked about.
      const other = join(configDir, 'settings.json');
      writeFileSync(other, '{\n  // untouched\n}\n', 'utf8');
      const refused = (await engine.extras.fix?.({
        fileId: 'config',
        path: other,
        scope: 'global',
      })) as ConfigMutation;
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/not one of opencode's global config paths/);
      expect(readFileSync(other, 'utf8')).toContain('//');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
