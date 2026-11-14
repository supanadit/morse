import { afterEach, describe, expect, it } from 'vitest';
import { discoverOpenAiCompatibleModels } from './providers.js';

describe('discoverOpenAiCompatibleModels', () => {
  const servers: { close: () => void }[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<string> {
    const { createServer } = await import('node:http');
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return typeof address === 'object' && address !== null
      ? `http://127.0.0.1:${address.port}/v1`
      : '';
  }

  it('lists models from the endpoint, mapping id and owned_by', async () => {
    const base = await listen((req, res) => {
      if (req.url?.endsWith('/models') && req.headers.authorization === 'Bearer sk-test') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'qwen3-coder', owned_by: 'acme' }, { id: 'm2' }] }));
        return;
      }
      res.statusCode = 401;
      res.end('{}');
    });
    const models = await discoverOpenAiCompatibleModels(base, { kind: 'stored', apiKey: 'sk-test' });
    expect(models).toEqual([
      { id: 'qwen3-coder', name: 'qwen3-coder (acme)' },
      { id: 'm2' },
    ]);
  });

  it('fills in the capabilities a listing happens to declare, and leaves the rest out', async () => {
    const base = await listen((req, res) => {
      if (!req.url?.endsWith('/models')) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            // OpenRouter's shape: context/price on top_provider, modalities on architecture.
            {
              id: 'vision-model',
              top_provider: { context_length: 200_000, max_completion_tokens: 8192 },
              architecture: { input_modalities: ['text', 'image'] },
            },
            // vLLM / llama.cpp: max_model_len, and a bare vision flag.
            { id: 'local-vlm', max_model_len: 32768, capabilities: { vision: true } },
            // A text-only model that says so.
            { id: 'plain', context_length: 128000, capabilities: { vision: false } },
            // A listing that says nothing: no field is invented for it.
            { id: 'mystery' },
            // Junk numbers are not a capability.
            { id: 'junk', context_length: 0, max_tokens: -5, max_output_tokens: 'many' },
          ],
        }),
      );
    });

    const models = await discoverOpenAiCompatibleModels(base, { kind: 'stored', apiKey: 'sk' });

    expect(models).toEqual([
      {
        id: 'vision-model',
        contextWindow: 200_000,
        maxTokens: 8192,
        input: ['text', 'image'],
      },
      { id: 'local-vlm', contextWindow: 32768, input: ['text', 'image'] },
      { id: 'plain', contextWindow: 128000, input: ['text'] },
      { id: 'mystery' },
      { id: 'junk' },
    ]);
  });

  it('reads the key from the named environment variable', async () => {
    process.env.MORSE_DISCOVER_TEST_KEY = 'sk-env';
    try {
      const base = await listen((req, res) => {
        if (req.headers.authorization === 'Bearer sk-env') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'one' }] }));
          return;
        }
        res.statusCode = 401;
        res.end('{}');
      });
      const models = await discoverOpenAiCompatibleModels(base, {
        kind: 'env',
        name: 'MORSE_DISCOVER_TEST_KEY',
      });
      expect(models).toEqual([{ id: 'one' }]);
    } finally {
      delete process.env.MORSE_DISCOVER_TEST_KEY;
    }
  });

  it('surfaces an env-backed credential error when the variable is unset', async () => {
    await expect(
      discoverOpenAiCompatibleModels('http://127.0.0.1:9/v1', {
        kind: 'env',
        name: 'MORSE_UNSET_VAR_XYZ',
      }),
    ).rejects.toThrow(/MORSE_UNSET_VAR_XYZ/);
  });

  it('surfaces the http status when the endpoint refuses the key', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 401;
      res.end('{}');
    });
    await expect(
      discoverOpenAiCompatibleModels(base, { kind: 'stored', apiKey: 'wrong' }),
    ).rejects.toThrow(/401/);
  });
});
