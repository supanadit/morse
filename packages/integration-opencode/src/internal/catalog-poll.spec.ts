import { describe, expect, it, vi } from 'vitest';
import { awaitSettledCatalog, credentialedProviders } from './catalog-poll.js';
import { silentLogger } from '@morse/system';

function scriptedApi(responses: unknown[]): { get: ReturnType<typeof vi.fn> } {
  const list = [...responses];
  return {
    get: vi.fn(async () => {
      const next = list.length > 1 ? list.shift() : list[0];
      if (next instanceof Error) {
        throw next;
      }
      return next as never;
    }),
  };
}

const row = (providerID: string, id: string) => ({ id, providerID });

describe('awaitSettledCatalog', () => {
  it('returns the first read when no provider holds a credential', async () => {
    const api = scriptedApi([[]]);
    const models = await awaitSettledCatalog(api, '/tmp', silentLogger, {
      intervalMs: 1,
    });
    expect(models).toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('returns at once when every credentialed provider already lists', async () => {
    const api = scriptedApi([[row('opencode-go', 'a')]]);
    const models = await awaitSettledCatalog(api, '/tmp', silentLogger, {
      intervalMs: 1,
      credentialProviders: ['opencode-go'],
    });
    expect(models).toHaveLength(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('waits while a credentialed provider is still missing, then reports it', async () => {
    const api = scriptedApi([[], [], [row('opencode-go', 'a')]]);
    const models = await awaitSettledCatalog(api, '/tmp', silentLogger, {
      intervalMs: 1,
      credentialProviders: ['opencode-go'],
    });
    expect(models).toHaveLength(1);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('gives up at the timeout and reports what it has', async () => {
    const api = scriptedApi([[], []]);
    const models = await awaitSettledCatalog(api, '/tmp', silentLogger, {
      intervalMs: 5,
      timeoutMs: 12,
      credentialProviders: ['opencode-go'],
    });
    expect(models).toEqual([]);
    expect(api.get.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats a failing read as still loading', async () => {
    const api = scriptedApi([new Error('flaky'), [row('opencode-go', 'a')]]);
    const models = await awaitSettledCatalog(api, '/tmp', silentLogger, {
      intervalMs: 1,
      timeoutMs: 500,
      credentialProviders: ['opencode-go'],
    });
    expect(models).toHaveLength(1);
  });
});

describe('credentialedProviders', () => {
  it('returns an empty list when nothing is stored and the CLI fails', () => {
    const ids = credentialedProviders({ url: '', password: '' }, silentLogger);
    expect(ids).toEqual([]);
  });
});
