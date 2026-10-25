import { describe, expect, it } from 'vitest';
import { silentLogger } from '@morse/system';
import type { OpenCodeApi } from './client.js';
import {
  defaultModeId,
  readAgentModes,
  readDefaultModel,
  type ApiAgent,
  type ApiConfigEntry,
} from './catalog.js';

/** The catalogs the mode picker reads: primary-only, default from config/order. */
class FakeApi {
  readonly calls: { path: string; query?: Record<string, string | undefined> }[] = [];

  constructor(
    private readonly agents: ApiAgent[],
    private readonly documents: ApiConfigEntry[],
  ) {}

  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    this.calls.push({ path, ...(query === undefined ? {} : { query }) });
    if (path === '/agent') {
      return Promise.resolve(this.agents as T);
    }
    if (path === '/config') {
      return Promise.resolve(this.documents as T);
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  }
}

const PRIMARY: ApiAgent[] = [
  { id: 'build', name: 'Build', mode: 'primary' },
  { id: 'general', name: 'General', mode: 'subagent' },
  { id: 'title', name: 'Title', mode: 'primary', hidden: true },
  { id: 'plan', name: 'Plan', mode: 'primary', description: 'Think first' },
];

describe('readAgentModes', () => {
  it('offers only primary, non-hidden agents in the server order', async () => {
    const api = new FakeApi(PRIMARY, []);
    const modes = await readAgentModes(api as unknown as OpenCodeApi, '/work', silentLogger);

    expect(modes.map((mode) => mode.id)).toEqual(['build', 'plan']);
    expect(modes[1]).toMatchObject({ name: 'Plan', description: 'Think first' });
    expect(api.calls).toEqual([
      { path: '/agent', query: { 'location[directory]': '/work' } },
      { path: '/config', query: { 'location[directory]': '/work' } },
    ]);
  });

  it('uses the last configuration document that sets default_agent', async () => {
    const api = new FakeApi(PRIMARY, [
      { type: 'document', info: { default_agent: 'plan' } },
      { type: 'document', info: { default_agent: 'build' } },
    ]);
    const modes = await readAgentModes(api as unknown as OpenCodeApi, '/work', silentLogger);

    expect(modes.find((mode) => mode.default)?.id).toBe('build');
    expect(defaultModeId(modes)).toBe('build');
  });

  it('follows a configured plan default rather than build', async () => {
    const api = new FakeApi(PRIMARY, [
      { type: 'directory', path: '/work' },
      { type: 'document', info: { default_agent: 'plan' } },
    ]);
    const modes = await readAgentModes(api as unknown as OpenCodeApi, '/work', silentLogger);

    expect(modes.find((mode) => mode.default)?.id).toBe('plan');
    expect(defaultModeId(modes)).toBe('plan');
  });

  it('falls back to the first primary agent when no default is configured', async () => {
    const api = new FakeApi(PRIMARY, []);
    const modes = await readAgentModes(api as unknown as OpenCodeApi, '/work', silentLogger);

    expect(modes.find((mode) => mode.default)?.id).toBe('build');
  });

  it('reflects a configuration that removed the previous default and a mode', async () => {
    const api = new FakeApi(
      [{ id: 'build', name: 'Build', mode: 'primary' }],
      [{ type: 'document', info: { default_agent: 'plan' } }],
    );
    const modes = await readAgentModes(api as unknown as OpenCodeApi, '/work', silentLogger);

    expect(modes).toEqual([{ id: 'build', name: 'Build', default: true }]);
  });

  it('returns no modes when the server offers no primary agents', async () => {
    const api = new FakeApi(
      [{ id: 'general', name: 'General', mode: 'subagent' }],
      [],
    );
    await expect(
      readAgentModes(api as unknown as OpenCodeApi, '/work', silentLogger),
    ).resolves.toEqual([]);
  });
});

describe('readDefaultModel', () => {
  it('reads the model the server would use and its location', async () => {
    const calls: unknown[] = [];
    const api = {
      get: (path: string, query: unknown) => {
        calls.push({ path, query });
        return Promise.resolve({ id: 'default', providerID: 'opencode' });
      },
    };
    await expect(
      readDefaultModel(api as unknown as OpenCodeApi, '/work', silentLogger),
    ).resolves.toMatchObject({ id: 'default' });
    expect(calls).toEqual([
      { path: '/model/default', query: { 'location[directory]': '/work' } },
    ]);
  });

  it('treats a null answer as no default', async () => {
    const api = { get: () => Promise.resolve(null) };
    await expect(
      readDefaultModel(api as unknown as OpenCodeApi, '/work', silentLogger),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the server cannot report one', async () => {
    const api = { get: () => Promise.reject(new Error('no model')) };
    await expect(
      readDefaultModel(api as unknown as OpenCodeApi, '/work', silentLogger),
    ).resolves.toBeUndefined();
  });
});
