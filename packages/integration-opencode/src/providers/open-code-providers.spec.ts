import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '@morse/protocol';

import { OpenCodeProviders } from './open-code-providers.js';

function setup(env: NodeJS.ProcessEnv = {}, api?: ConstructorParameters<typeof OpenCodeProviders>[0]['api']) {
  const base = mkdtempSync(join(tmpdir(), 'oc-providers-'));
  const configHome = join(base, 'config');
  const dataHome = join(base, 'data');
  const providers = new OpenCodeProviders({
    env: { ...process.env, ...env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
    ...(api === undefined ? {} : { api }),
  });
  return {
    configPath: join(configHome, 'opencode', 'opencode.json'),
    authPath: join(dataHome, 'opencode', 'auth.json'),
    providers,
  };
}

async function list(providers: OpenCodeProviders): Promise<ProviderStatus> {
  return (await providers.list()) as ProviderStatus;
}

describe('OpenCodeProviders', () => {
  it('lists the credentials OpenCode has stored with full model fields', async () => {
    const { authPath, providers } = setup();
    mkdirSync(join(authPath, '..'), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-test' } }), { mode: 0o600 });
    const status = await list(providers);
    expect(status.providers.find((one) => one.id === 'opencode-go')).toMatchObject({
      name: 'Opencode Go',
      kind: 'builtin',
      connected: true,
      source: 'stored',
    });
  });

  it('writes a custom provider with full model fields and keeps its shape on disconnect', async () => {
    const { configPath, providers } = setup();
    await providers.connect({
      providerId: 'my-gateway',
      name: 'My gateway',
      baseURL: 'https://llm.example.com/v1',
      api: 'openai-completions',
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          contextWindow: 100000,
          maxTokens: 8000,
          input: ['text', 'image'],
          reasoning: true,
          thinkingLevels: ['low', 'high'],
        },
        { id: 'model-b' },
      ],
      key: 'sk-abc',
    });

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const model = config.providers['my-gateway'].models['model-a'];
    expect(model).toMatchObject({
      name: 'Model A',
      limit: { context: 100000, output: 8000 },
      capabilities: { input: ['text', 'image'] },
      reasoning: true,
    });
    expect(model.variants).toEqual([{ id: 'low' }, { id: 'high' }]);
    const custom = (await list(providers)).providers.find((one) => one.id === 'my-gateway');
    expect(custom?.models?.[0]).toMatchObject({
      id: 'model-a',
      name: 'Model A',
      contextWindow: 100000,
      maxTokens: 8000,
      input: ['text', 'image'],
      thinkingLevels: ['low', 'high'],
    });

    await providers.disconnect({ providerId: 'my-gateway' });
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(after.providers['my-gateway'].settings.baseURL).toBe('https://llm.example.com/v1');
    expect(after.providers['my-gateway'].settings.apiKey).toBeUndefined();
  });

  it('writes a pasted key for a known provider into OpenCode’s auth file', async () => {
    const { authPath, providers } = setup();
    expect((await providers.connect({ providerId: 'anthropic', key: 'sk-ant' })) as { ok: boolean }).toMatchObject({ ok: true });
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    expect(auth.anthropic).toEqual({ type: 'api', key: 'sk-ant' });
  });

  it('hands any safe provider id to OpenCode’s own auth login', async () => {
    const { providers } = setup();
    const go = (await providers.loginCommand({ providerId: 'opencode-go' })) as {
      file: string;
      args: string[];
    };
    expect(go.args).toEqual(['auth', 'login', 'opencode-go']);
    expect(await providers.loginCommand({ providerId: 'opencode-go; rm -rf /' })).toBeUndefined();
  });

  it('lists OpenCode’s own integration registry and saves a pasted key natively', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api = {
      get: async (path: string) => {
        calls.push({ method: 'get', path });
        return path === '/integration'
          ? [{ id: 'anthropic', name: 'Anthropic', methods: [{ type: 'key' }, { type: 'oauth' }], connections: [] }]
          : [];
      },
      post: async (path: string, body?: unknown) => {
        calls.push({ method: 'post', path, body });
        return undefined;
      },
      delete: async (path: string) => {
        calls.push({ method: 'delete', path });
      },
    } as unknown as ConstructorParameters<typeof OpenCodeProviders>[0]['api'];
    const { providers } = setup({}, api);

    expect((await list(providers)).providers.find((one) => one.id === 'anthropic')).toMatchObject({
      name: 'Anthropic',
      auth: { key: true, signIn: true },
    });
    expect((await providers.connect({ providerId: 'anthropic', key: 'sk-test' })) as { ok: boolean }).toMatchObject({ ok: true });
    expect(calls).toContainEqual({
      method: 'post',
      path: '/integration/anthropic/connect/key',
      body: { key: 'sk-test' },
    });
  });
});
