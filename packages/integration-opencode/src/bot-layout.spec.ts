import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotEngineConfig } from '@morse/system';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_BOT_AGENT,
  openCodeBotLayout,
  openCodeConfigPath,
  openCodeLegacyPersonaPath,
  writeOpenCodeBotConfig,
} from './bot-layout.js';

/**
 * OpenCode's own layout, as OpenCode reads it: one `opencode.json` that follows
 * opencode.ai/config.json, the persona through `instructions`, the workspace
 * document at the project root, and keys in OpenCode's auth store inside the
 * bot's data dir. These tests pin the paths and the schema keys, because a
 * config OpenCode does not read is a config that silently does nothing.
 */
describe('openCodeBotLayout', () => {
  let botRoot: string;

  beforeEach(() => {
    botRoot = mkdtempSync(join(tmpdir(), 'morse-opencode-layout-'));
  });

  afterEach(() => {
    rmSync(botRoot, { recursive: true, force: true });
  });

  const config: BotEngineConfig = {
    username: 'news-finder',
    name: 'News Finder',
    description: 'Finds the news',
    persona: 'You are News Finder.',
    agentsMd: '# workspace rules\n',
    credentials: [{ provider: 'anthropic', apiKey: 'sk-ant' }],
    providers: [
      {
        id: 'acme',
        label: 'Acme AI',
        api: 'openai-completions',
        baseUrl: 'https://llm.acme.example/v1',
        credential: { kind: 'stored', apiKey: 'sk-acme' },
        models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 128_000, maxTokens: 8_192 }],
      },
    ],
    model: { provider: 'acme', id: 'acme-chat', name: 'Acme Chat' },
    thinkingLevel: 'medium',
    subagents: [{ name: 'reviewer', prompt: 'Read the diff.\nSecond line.' }],
  };

  it('writes opencode.json where the bot server reads it, with the schema', () => {
    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(openCodeConfigPath(botRoot)).toBe(join(botRoot, 'config', 'opencode', 'opencode.json'));
    expect(file['$schema']).toBe('https://opencode.ai/config.json');
    // OpenCode's own display-name field.
    expect(file['username']).toBe('News Finder');
    // `provider/model`, the string form its `model` key takes.
    expect(file['model']).toBe('acme/acme-chat');
    // The bot is an agent of its own, and the default one: its `system` is the
    // persona (opencode.ai/docs/agents — a non-empty `system` replaces the
    // provider's base prompt for that agent).
    expect(file['default_agent']).toBe(OPENCODE_BOT_AGENT);
    expect((file['agents'] as Record<string, Record<string, unknown>>)['morse']).toEqual({
      mode: 'primary',
      description: 'Finds the news',
      system: 'You are News Finder.',
    });
  });

  it('writes providers in the schema shape: package, settings, models, limits', () => {
    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      providers: Record<string, Record<string, unknown>>;
    };
    const provider = file.providers['acme'];
    expect(provider).toMatchObject({
      name: 'Acme AI',
      package: '@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://llm.acme.example/v1', apiKey: 'sk-acme' },
    });
    expect((provider?.['models'] as Record<string, unknown>)['acme-chat']).toEqual({
      name: 'Acme Chat',
      limit: { context: 128_000, output: 8_192 },
    });
  });

  it('writes subagents beside the bot agent, and the workspace document at the root', () => {
    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
      instructions: string[];
    };
    expect(file.agents['reviewer']).toEqual({
      mode: 'subagent',
      description: 'Read the diff.',
      system: 'Read the diff.\nSecond line.',
    });
    // The persona is not a file any more: it is the bot agent's `system`.
    expect(file.agents['morse']?.['system']).toBe('You are News Finder.');
    expect(file.instructions).toEqual([join(botRoot, 'workspace', 'AGENTS.md')]);
    expect(readFileSync(join(botRoot, 'workspace', 'AGENTS.md'), 'utf8')).toBe(
      '# workspace rules\n',
    );
  });

  it('keeps the keys in OpenCode own auth store inside the bot data dir', () => {
    writeOpenCodeBotConfig(botRoot, config);

    expect(
      JSON.parse(readFileSync(join(botRoot, 'sessions', 'opencode', 'auth.json'), 'utf8')),
    ).toEqual({ anthropic: { type: 'api', key: 'sk-ant' } });
  });

  it('preserves what it does not own, and drops what the form removed', () => {
    // A reader hand-added an MCP server and a plugin before the wizard ran.
    const path = openCodeConfigPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcp: { toso: { type: 'remote', url: 'https://example.test/mcp' } } }),
    );

    writeOpenCodeBotConfig(botRoot, config);
    const first = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(first['mcp']).toEqual({ toso: { type: 'remote', url: 'https://example.test/mcp' } });

    // Removing the provider and the subagent in the form removes them here too.
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      providers: [],
      subagents: [],
      model: null,
      persona: '',
    });
    const second = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(second['providers']).toEqual({});
    // Only the subagent goes; the bot's own agent entry stays.
    expect(second['agents']).toEqual({
      morse: { mode: 'primary', description: 'Finds the news', system: '' },
    });
    expect(second['model']).toBeUndefined();
    expect(second['instructions']).toEqual([join(botRoot, 'workspace', 'AGENTS.md')]);
    // The agent stays, with an empty system: OpenCode keeps its own base prompt.
    expect((second['agents'] as Record<string, Record<string, unknown>>)['morse']).toEqual({
      mode: 'primary',
      description: 'Finds the news',
      system: '',
    });
    // The keys were not part of that edit, so they survive.
    expect(
      JSON.parse(readFileSync(join(botRoot, 'sessions', 'opencode', 'auth.json'), 'utf8')),
    ).toEqual({ anthropic: { type: 'api', key: 'sk-ant' } });
  });

  it('folds a persona written as an instruction file into the agent system prompt', () => {
    // What the previous layout left behind: persona.md named by `instructions`,
    // which OpenCode treats as appended context rather than the system prompt.
    const path = openCodeConfigPath(botRoot);
    const legacy = openCodeLegacyPersonaPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode', 'instructions'), { recursive: true });
    writeFileSync(legacy, 'You are News Finder.\n');
    writeFileSync(path, JSON.stringify({ username: 'News Finder', instructions: [legacy] }));

    openCodeBotLayout.repair?.(botRoot);

    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(file['default_agent']).toBe(OPENCODE_BOT_AGENT);
    expect((file['agents'] as Record<string, Record<string, unknown>>)['morse']).toMatchObject({
      mode: 'primary',
      system: 'You are News Finder.\n',
    });
    expect(file['instructions']).toEqual([]);
    // The old file is gone: leaving it would append the character a second time.
    expect(existsSync(legacy)).toBe(false);
    expect(openCodeBotLayout.read(botRoot).persona).toBe('You are News Finder.\n');
  });

  it('moves subagents from the deprecated singular agent key to agents', () => {
    // What the previous layout wrote: OpenCode's older `agent` key, with `prompt`.
    const path = openCodeConfigPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcp: { toso: { type: 'remote', url: 'https://example.test/mcp' } },
        agent: {
          reviewer: {
            mode: 'subagent',
            description: 'Read the diff.',
            prompt: 'Read the diff and report risks.',
          },
        },
      }),
    );

    openCodeBotLayout.repair?.(botRoot);

    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(file['agent']).toBeUndefined();
    expect(file['agents']).toEqual({
      reviewer: {
        mode: 'subagent',
        description: 'Read the diff.',
        system: 'Read the diff and report risks.',
      },
    });
    // Everything Morse does not own survives the repair.
    expect(file['mcp']).toEqual({ toso: { type: 'remote', url: 'https://example.test/mcp' } });
    expect(openCodeBotLayout.read(botRoot).subagents).toEqual([
      { name: 'reviewer', prompt: 'Read the diff and report risks.' },
    ]);
  });

  it('allows exactly the tools the reader chose, as a permissions ruleset', () => {
    writeOpenCodeBotConfig(botRoot, { ...config, tools: ['read', 'webfetch'] });

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    // A blanket deny first, then one allow per chosen tool: OpenCode evaluates the
    // rules in order, so anything not chosen stays denied.
    expect(file.agents['morse']?.['permissions']).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'webfetch', resource: '*', effect: 'allow' },
    ]);
    expect(openCodeBotLayout.read(botRoot).tools).toEqual(['read', 'webfetch']);

    // No tools at all is the deny alone.
    writeOpenCodeBotConfig(botRoot, { ...config, tools: [] });
    const none = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(none.agents['morse']?.['permissions']).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
    ]);
  });

  it('keeps a stored model when the caller does not know it, and clears only on demand', () => {
    writeOpenCodeBotConfig(botRoot, config);

    writeOpenCodeBotConfig(botRoot, { ...config, model: undefined, persona: 'Updated.' });
    let file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(file['model']).toBe('acme/acme-chat');

    writeOpenCodeBotConfig(botRoot, { ...config, model: null });
    file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as Record<string, unknown>;
    expect(file['model']).toBeUndefined();
  });

  it('reads the configuration back for Edit bot', () => {
    writeOpenCodeBotConfig(botRoot, config);

    expect(openCodeBotLayout.read(botRoot)).toEqual({
      model: { provider: 'acme', id: 'acme-chat', name: 'acme-chat' },
      // The persona is the bot agent's system prompt, read back from the config.
      persona: 'You are News Finder.',
      agentsMd: '# workspace rules\n',
      subagents: [{ name: 'reviewer', prompt: 'Read the diff.\nSecond line.' }],
    });
  });
});
