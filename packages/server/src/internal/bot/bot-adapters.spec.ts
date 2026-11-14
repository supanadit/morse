import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@morse/system';
import { afterEach, describe, expect, it } from 'vitest';
import { createBotAdapters } from './bot-adapters.js';

/**
 * The host's bot-engine wiring. Whether an engine can store named subagents is a
 * per-engine truth, and this table is where it becomes something `BotService`
 * can act on: a method for OpenCode, nothing for pi.
 */
describe('createBotAdapters', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const dir of roots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempBotRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'morse-bot-adapters-'));
    roots.push(dir);
    return dir;
  }

  it('gives OpenCode a subagent writer and pi neither the method nor the claim', () => {
    const adapters = createBotAdapters({ logger: silentLogger });

    expect(adapters['opencode']?.capabilities.supportsSubagents).toBe(true);
    expect(typeof adapters['opencode']?.writeSubagents).toBe('function');
    // pi has no named subagents, so the service must never reach a writer for it.
    expect(adapters['pi']?.capabilities.supportsSubagents).toBe(false);
    expect(adapters['pi']?.writeSubagents).toBeUndefined();
    // Both engines take provider records — each writes its own native shape.
    expect(typeof adapters['pi']?.writeProviders).toBe('function');
    expect(typeof adapters['opencode']?.writeProviders).toBe('function');
  });

  it('writes a provider into each engine config at the path the bot engine reads', () => {
    const adapters = createBotAdapters({ logger: silentLogger });
    const piRoot = tempBotRoot();
    const ocRoot = tempBotRoot();
    const provider = {
      id: 'acme',
      label: 'Acme',
      api: 'openai-completions' as const,
      baseUrl: 'https://llm.acme.example/v1',
      credential: { kind: 'stored' as const, apiKey: 'sk-acme' },
      models: [{ id: 'qwen3-coder', name: 'Qwen 3 Coder' }],
    };

    adapters['pi']?.writeProviders?.(piRoot, [provider]);
    adapters['opencode']?.writeProviders?.(ocRoot, [provider]);

    const piConfig = JSON.parse(readFileSync(join(piRoot, 'config', 'models.json'), 'utf8'));
    expect(piConfig.providers.acme.api).toBe('openai-completions');
    expect(piConfig.providers.acme.models).toEqual([{ id: 'qwen3-coder', name: 'Qwen 3 Coder' }]);
    const ocConfig = JSON.parse(readFileSync(join(ocRoot, 'config', 'opencode', 'opencode.json'), 'utf8'));
    expect(ocConfig.providers.acme.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(ocConfig.providers.acme.models).toEqual({ 'qwen3-coder': { name: 'Qwen 3 Coder' } });
  });

  it('writes a subagent at the config path the bot engine reads', () => {
    const adapters = createBotAdapters({ logger: silentLogger });
    const botRoot = tempBotRoot();

    adapters['opencode']?.writeSubagents?.(botRoot, [
      { name: 'reviewer', prompt: 'Read the diff and report risks.' },
    ]);

    // Task 4's invariant: the bot's OpenCode config dir is
    // `<botRoot>/config/opencode`, so this is the file its server reads.
    const path = join(botRoot, 'config', 'opencode', 'opencode.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      agent: {
        reviewer: {
          mode: 'subagent',
          description: 'Read the diff and report risks.',
          prompt: 'Read the diff and report risks.',
        },
      },
    });
  });
});
