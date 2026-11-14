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

  it('gives every engine a layout, and only OpenCode named subagents', () => {
    const adapters = createBotAdapters({ logger: silentLogger });

    // Both engines take the whole configuration through their own layout.
    expect(typeof adapters['pi']?.layout.write).toBe('function');
    expect(typeof adapters['pi']?.layout.read).toBe('function');
    expect(typeof adapters['opencode']?.layout.write).toBe('function');
    expect(typeof adapters['opencode']?.layout.read).toBe('function');
    // Named subagents are OpenCode's feature; pi's layout simply never writes them.
    expect(adapters['opencode']?.capabilities.supportsSubagents).toBe(true);
    expect(adapters['pi']?.capabilities.supportsSubagents).toBe(false);
  });

  it('writes each engine configuration where that engine reads it', () => {
    const adapters = createBotAdapters({ logger: silentLogger });
    const piRoot = tempBotRoot();
    const ocRoot = tempBotRoot();
    const config = {
      username: 'news-finder',
      name: 'News Finder',
      description: 'Finds the news',
      persona: 'You are News Finder.',
      credentials: [{ provider: 'anthropic', apiKey: 'sk-ant' }],
      providers: [
        {
          id: 'acme',
          label: 'Acme',
          api: 'openai-completions' as const,
          baseUrl: 'https://llm.acme.example/v1',
          credential: { kind: 'stored' as const, apiKey: 'sk-acme' },
          models: [{ id: 'qwen3-coder', name: 'Qwen 3 Coder' }],
        },
      ],
      model: { provider: 'acme', id: 'qwen3-coder', name: 'Qwen 3 Coder' },
      subagents: [{ name: 'reviewer', prompt: 'Read the diff.' }],
    };

    adapters['pi']?.layout.write(piRoot, config);
    adapters['opencode']?.layout.write(ocRoot, config);

    // pi: `PI_CODING_AGENT_DIR` is `<botRoot>/config`, so that dir is its agent
    // dir — models.json, settings.json, auth.json and AGENTS.md.
    const piModels = JSON.parse(readFileSync(join(piRoot, 'config', 'models.json'), 'utf8'));
    expect(piModels.providers.acme.api).toBe('openai-completions');
    expect(JSON.parse(readFileSync(join(piRoot, 'config', 'settings.json'), 'utf8'))).toMatchObject(
      { defaultProvider: 'acme', defaultModel: 'qwen3-coder' },
    );
    expect(readFileSync(join(piRoot, 'config', 'SYSTEM.md'), 'utf8')).toBe(
      'You are News Finder.\n',
    );

    // OpenCode: one opencode.json following opencode.ai/config.json.
    const ocConfig = JSON.parse(
      readFileSync(join(ocRoot, 'config', 'opencode', 'opencode.json'), 'utf8'),
    );
    expect(ocConfig['$schema']).toBe('https://opencode.ai/config.json');
    expect(ocConfig.model).toBe('acme/qwen3-coder');
    expect(ocConfig.providers.acme.package).toBe('@ai-sdk/openai-compatible');
    expect(ocConfig.providers.acme.models).toEqual({
      'qwen3-coder': { name: 'Qwen 3 Coder' },
    });
    expect(ocConfig.agents.reviewer).toEqual({
      mode: 'subagent',
      description: 'Read the diff.',
      system: 'Read the diff.',
    });
  });

  it('reads a bot configuration back out of each engine own files', () => {
    const adapters = createBotAdapters({ logger: silentLogger });
    const piRoot = tempBotRoot();
    const ocRoot = tempBotRoot();
    const config = {
      username: 'news-finder',
      name: 'News Finder',
      description: '',
      persona: 'You are News Finder.',
      credentials: [],
      providers: [],
      model: { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude' },
      thinkingLevel: 'high' as const,
    };

    adapters['pi']?.layout.write(piRoot, config);
    adapters['opencode']?.layout.write(ocRoot, config);

    expect(adapters['pi']?.layout.read(piRoot)).toMatchObject({
      model: { provider: 'anthropic', id: 'claude-sonnet-4' },
      thinkingLevel: 'high',
      persona: 'You are News Finder.\n',
    });
    // OpenCode keeps the persona as the bot agent's system prompt, so it reads
    // back exactly as it was written — no trailing newline, because it is a JSON
    // string rather than a file.
    expect(adapters['opencode']?.layout.read(ocRoot)).toMatchObject({
      model: { provider: 'anthropic', id: 'claude-sonnet-4' },
      persona: 'You are News Finder.',
    });
  });
});
