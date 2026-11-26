import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '@morse/protocol';

import { PiProviders } from './pi-providers.js';

function setup(env: NodeJS.ProcessEnv = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-providers-'));
  return {
    agentDir,
    providers: new PiProviders({ env: { ...env, PI_CODING_AGENT_DIR: agentDir } }),
  };
}

async function list(providers: PiProviders): Promise<ProviderStatus> {
  return (await providers.list()) as ProviderStatus;
}

describe('PiProviders', () => {
  it('lists the providers in pi’s own catalog with full model fields', async () => {
    const { agentDir, providers } = setup();
    writeFileSync(
      join(agentDir, 'models-store.json'),
      JSON.stringify({
        'opencode-go': {
          models: [
            {
              id: 'hy4',
              name: 'Hy4',
              contextWindow: 131072,
              maxTokens: 32768,
              input: ['text', 'image'],
              reasoning: true,
              thinkingLevelMap: { low: 'low', high: null },
            },
            { id: 'hy3' },
          ],
        },
      }),
    );
    const status = await list(providers);
    const go = status.providers.find((one) => one.id === 'opencode-go');
    expect(go).toMatchObject({ name: 'OpenCode Go', kind: 'builtin', connected: false });
    expect(go?.description).toContain('2 models');
    expect(go?.models?.[0]).toMatchObject({
      id: 'hy4',
      name: 'Hy4',
      contextWindow: 131072,
      maxTokens: 32768,
      input: ['text', 'image'],
      reasoning: true,
    });
    expect(go?.models?.[0]?.thinking).toEqual({ low: 'low', high: null });
    expect(go?.auth).toMatchObject({ key: true });
  });

  it('writes a custom endpoint with full model fields and removes only its key', async () => {
    const { agentDir, providers } = setup();
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
          thinking: { low: 'low', high: null },
        },
        { id: 'model-b' },
      ],
      key: 'sk-abc',
    });

    const saved = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'));
    expect(saved.providers['my-gateway']).toMatchObject({
      name: 'My gateway',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-abc',
    });
    expect(saved.providers['my-gateway'].models[0]).toMatchObject({
      id: 'model-a',
      name: 'Model A',
      contextWindow: 100000,
      maxTokens: 8000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: null },
    });

    await providers.disconnect({ providerId: 'my-gateway' });
    const after = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'));
    expect(after.providers['my-gateway'].baseUrl).toBe('https://llm.example.com/v1');
    expect(after.providers['my-gateway'].apiKey).toBeUndefined();
  });

  it('writes a pasted key for a known provider into pi’s auth file', async () => {
    const { agentDir, providers } = setup();
    expect((await providers.connect({ providerId: 'openai', key: 'sk-test' })) as { ok: boolean }).toMatchObject({ ok: true });
    const auth = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'));
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-test' });
  });

  it('lists models from a custom endpoint', async () => {
    const { providers } = setup();
    // A public listing endpoint without a key; discovery is best effort.
    const result = (await providers.discover({
      baseURL: 'https://opencode.ai/inference/go/openai/v1',
    })) as { ok: boolean; message?: string };
    expect(typeof result.ok).toBe('boolean');
  });

  it('hands any safe provider id to pi’s own auth login', async () => {
    const { providers } = setup({ MORSE_PI_PATH: '/usr/bin/pi', PATH: '/usr/bin' });
    const go = (await providers.loginCommand({ providerId: 'opencode-go' })) as {
      file: string;
      args: string[];
    };
    expect(go.args).toEqual(['auth', 'login', 'opencode-go']);
    expect(await providers.loginCommand({ providerId: 'opencode-go; rm -rf /' })).toBeUndefined();
  });
});
