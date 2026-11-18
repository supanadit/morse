import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOT_BUS_INSTRUCTION, type BotEngineConfig } from '@morse/system';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_BOT_AGENT,
  openCodeBotLayout,
  openCodeConfigPath,
  openCodeInstructionPath,
  openCodeLegacyPersonaPath,
  writeOpenCodeBotConfig,
} from './bot-layout.js';
import {
  OPENCODE_BUS_PLUGIN_FILE,
  OPENCODE_BUS_PLUGIN_START,
  openCodeBusPluginPath,
  openCodeBusPluginSource,
} from './bot-bus-plugin.js';
import { botUserSpacePluginPath } from './bot-user-space.js';

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
      instructions: [openCodeInstructionPath(botRoot)],
    });
  });

  it('installs the user-space shell plugin beside the config', () => {
    writeOpenCodeBotConfig(botRoot, config);

    expect(existsSync(botUserSpacePluginPath(botRoot))).toBe(true);
  });

  it('installs the bot-bus plugin where OpenCode discovers it', () => {
    writeOpenCodeBotConfig(botRoot, config);

    // A direct `.ts` file in the plugins directory is discovered by OpenCode, so
    // the asset is the file itself — there is no entry to add to `opencode.json`.
    expect(openCodeBusPluginPath(botRoot)).toBe(
      join(botRoot, 'config', 'opencode', 'plugins', OPENCODE_BUS_PLUGIN_FILE),
    );
    expect(readFileSync(openCodeBusPluginPath(botRoot), 'utf8')).toBe(openCodeBusPluginSource());
  });

  it('adds no plugins entry to a config that had none', () => {
    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as Record<
      string,
      unknown
    >;
    // A bare file path in `plugins` is skipped by OpenCode; the discovery of the
    // plugins directory is what loads Morse's asset, so the key must stay absent.
    expect(file['plugins']).toBeUndefined();
  });

  it('leaves a reader’s own plugins entry alone', () => {
    // The reader configured a plugin of their own before the wizard ran: the save
    // must keep every path exactly as it was and add none.
    const path = openCodeConfigPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(path, JSON.stringify({ plugins: ['@acme/opencode-plugin'] }));

    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(path, 'utf8')) as { plugins: string[] };
    expect(file.plugins).toEqual(['@acme/opencode-plugin']);
    expect(
      existsSync(join(botRoot, 'config', 'opencode', 'plugins', OPENCODE_BUS_PLUGIN_FILE)),
    ).toBe(true);
  });

  it('writes the bot-bus plugin idempotently across saves', () => {
    writeOpenCodeBotConfig(botRoot, config);
    const first = readFileSync(openCodeBusPluginPath(botRoot), 'utf8');

    writeOpenCodeBotConfig(botRoot, config);

    expect(readFileSync(openCodeBusPluginPath(botRoot), 'utf8')).toBe(first);
  });

  it('never touches another plugin in the plugins directory', () => {
    // The plugins directory is also where the reader puts their own plugins; the
    // generated file says so. A save and a repair write Morse's file and only it.
    const plugins = join(botRoot, 'config', 'opencode', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const own = join(plugins, 'reader-tools.ts');
    writeFileSync(own, 'export default Plugin.define({ id: "reader.tools" })\n');

    writeOpenCodeBotConfig(botRoot, config);
    openCodeBotLayout.repair?.(botRoot);

    expect(readFileSync(own, 'utf8')).toBe(
      'export default Plugin.define({ id: "reader.tools" })\n',
    );
    expect(readFileSync(openCodeBusPluginPath(botRoot), 'utf8')).toBe(openCodeBusPluginSource());
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

  it('writes the modalities a reader corrected, so a vision model is used as one', () => {
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      providers: [
        {
          ...config.providers[0]!,
          models: [
            {
              id: 'acme-vision',
              name: 'Acme Vision',
              contextWindow: 200_000,
              maxTokens: 4096,
              input: ['text', 'image'],
            },
          ],
        },
      ],
    });

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      providers: Record<string, { models: Record<string, unknown> }>;
    };
    // `capabilities.input` is the schema's field for what a model accepts; without
    // it OpenCode treats a vision model as text-only.
    expect(file.providers['acme']?.models['acme-vision']).toEqual({
      name: 'Acme Vision',
      limit: { context: 200_000, output: 4096 },
      capabilities: { input: ['text', 'image'] },
    });
  });

  it('corrects a model without costing the reader the key it never shows', () => {
    writeOpenCodeBotConfig(botRoot, config);

    // What Edit bot sends: the provider read back from opencode.json, so neither a
    // credential nor an api — only the model fields it corrected.
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      credentials: [],
      providers: [
        {
          id: 'acme',
          label: 'Acme AI',
          models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 64_000, maxTokens: 4_096 }],
        },
      ],
    });

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(file.providers['acme']).toMatchObject({
      name: 'Acme AI',
      package: '@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://llm.acme.example/v1', apiKey: 'sk-acme' },
    });
    expect((file.providers['acme']?.['models'] as Record<string, unknown>)['acme-chat']).toEqual({
      name: 'Acme Chat',
      limit: { context: 64_000, output: 4_096 },
    });
  });

  it('reads the providers back, with their limits and modalities', () => {
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      providers: [
        {
          ...config.providers[0]!,
          models: [
            {
              id: 'acme-chat',
              name: 'Acme Chat',
              contextWindow: 128_000,
              maxTokens: 8_192,
              input: ['text'],
            },
          ],
        },
      ],
    });

    const state = openCodeBotLayout.read(botRoot);

    // No credential: OpenCode's key stays in its own settings block, unread.
    expect(state.providers).toEqual([
      {
        id: 'acme',
        label: 'Acme AI',
        api: 'openai-completions',
        baseUrl: 'https://llm.acme.example/v1',
        models: [
          {
            id: 'acme-chat',
            name: 'Acme Chat',
            contextWindow: 128_000,
            maxTokens: 8_192,
            input: ['text'],
          },
        ],
      },
    ]);
  });

  it('says nothing about providers when the bot config declares none', () => {
    writeOpenCodeBotConfig(botRoot, { ...config, providers: [] });

    expect(openCodeBotLayout.read(botRoot).providers).toBeUndefined();
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

  it('adds the bot-bus instruction to the agent, and leaves the persona alone', () => {
    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
      instructions: string[];
    };
    // The habit is the agent's own instruction file, so it is named on the agent
    // rather than at the top level, where the workspace document lives.
    expect(file.agents['morse']?.['instructions']).toEqual([openCodeInstructionPath(botRoot)]);
    expect(file.agents['morse']?.['system']).toBe('You are News Finder.');
    expect(readFileSync(openCodeInstructionPath(botRoot), 'utf8')).toBe(`${BOT_BUS_INSTRUCTION}\n`);
    expect(file.instructions).toEqual([join(botRoot, 'workspace', 'AGENTS.md')]);
  });

  it('keeps the agent instructions it already had, and adds only one copy', () => {
    // A reader's own instruction on the bot agent: a rewrite must carry it over,
    // and a second save must not leave two names for the same habit.
    const path = openCodeConfigPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        agents: {
          morse: {
            mode: 'primary',
            system: 'You are News Finder.',
            instructions: ['/reader/notes.md'],
          },
        },
      }),
    );

    writeOpenCodeBotConfig(botRoot, config);
    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, string[]>;
    };
    expect(file.agents['morse']?.['instructions']).toEqual([
      '/reader/notes.md',
      openCodeInstructionPath(botRoot),
    ]);
  });

  it('puts the instruction file and its entry back after a repair', () => {
    writeOpenCodeBotConfig(botRoot, config);
    const path = openCodeConfigPath(botRoot);
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    delete file.agents['morse']!['instructions'];
    writeFileSync(path, JSON.stringify(file));
    rmSync(join(botRoot, 'config', 'opencode', 'instructions'), { recursive: true, force: true });

    openCodeBotLayout.repair?.(botRoot);

    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(readFileSync(openCodeInstructionPath(botRoot), 'utf8')).toBe(`${BOT_BUS_INSTRUCTION}\n`);
    expect(repaired.agents['morse']?.['instructions']).toEqual([openCodeInstructionPath(botRoot)]);
  });

  it('puts the bus plugin back when it was deleted', () => {
    writeOpenCodeBotConfig(botRoot, config);
    rmSync(openCodeBusPluginPath(botRoot));

    openCodeBotLayout.repair?.(botRoot);

    // Repair is what a bot from before the plugin existed goes through on the next
    // host start, so a missing asset is regenerated without a trip to the wizard.
    expect(readFileSync(openCodeBusPluginPath(botRoot), 'utf8')).toBe(openCodeBusPluginSource());
  });

  it('replaces a markerless file at the bus plugin path, because the path is Morse’s', () => {
    // The plugins directory also holds the reader's own plugins, but this file is
    // Morse's: a reader who edited it, or wrote a plugin under its name, gets a
    // fresh copy — their own plugin belongs in a separate file.
    const path = openCodeBusPluginPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode', 'plugins'), { recursive: true });
    writeFileSync(path, 'export default Plugin.define({ id: "mine" })\n');

    openCodeBotLayout.repair?.(botRoot);

    expect(readFileSync(path, 'utf8')).toBe(openCodeBusPluginSource());
  });

  it('refreshes a bus plugin whose version is not the one this code writes', () => {
    const path = openCodeBusPluginPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode', 'plugins'), { recursive: true });
    writeFileSync(
      path,
      `${OPENCODE_BUS_PLUGIN_START.replace('v1', 'v0')}\nexport default {};\n// morse-bot-bus:end\n`,
    );

    openCodeBotLayout.repair?.(botRoot);

    expect(readFileSync(path, 'utf8')).toBe(openCodeBusPluginSource());
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
      morse: {
        mode: 'primary',
        description: 'Finds the news',
        system: '',
        instructions: [openCodeInstructionPath(botRoot)],
      },
    });
    expect(second['model']).toBeUndefined();
    expect(second['instructions']).toEqual([join(botRoot, 'workspace', 'AGENTS.md')]);
    // The agent stays, with an empty system: OpenCode keeps its own base prompt.
    expect((second['agents'] as Record<string, Record<string, unknown>>)['morse']).toEqual({
      mode: 'primary',
      description: 'Finds the news',
      system: '',
      instructions: [openCodeInstructionPath(botRoot)],
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
    // The shell plugin is a repair's job too, so a bot from before it existed
    // gets it on the next host start without a trip through the wizard.
    expect(existsSync(botUserSpacePluginPath(botRoot))).toBe(true);
  });

  it('translates a generated ruleset while folding the legacy persona', () => {
    // The worst case the repair has to survive: a bot from the persona-file era
    // that also carries a generated ruleset. Rebuilding the agent entry to fold
    // the persona would drop `permissions`, leaving the bot unrestricted.
    const path = openCodeConfigPath(botRoot);
    const legacy = openCodeLegacyPersonaPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode', 'instructions'), { recursive: true });
    writeFileSync(legacy, 'You are News Finder.\n');
    writeFileSync(
      path,
      JSON.stringify({
        username: 'News Finder',
        instructions: [legacy],
        agents: {
          morse: {
            model: 'acme/acme-chat',
            permissions: [
              { action: '*', resource: '*', effect: 'deny' },
              { action: 'read', resource: '*', effect: 'allow' },
              { action: 'bash', resource: '*', effect: 'allow' },
            ],
          },
        },
      }),
    );

    openCodeBotLayout.repair?.(botRoot);

    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    // Every field on the entry comes through: the persona folded in, the ruleset
    // translated, and the model the reader picked still there.
    expect(file.agents['morse']).toEqual({
      model: 'acme/acme-chat',
      mode: 'primary',
      system: 'You are News Finder.\n',
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'shell', resource: '*', effect: 'allow' },
        { action: 'external_directory', resource: '*', effect: 'allow' },
      ],
      instructions: [openCodeInstructionPath(botRoot)],
    });
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
    // The shell plugin is a repair's job too: a bot created before it existed
    // gets it on the next host start, without a trip through the wizard.
    expect(existsSync(botUserSpacePluginPath(botRoot))).toBe(true);
  });

  it('carries a deprecated agent ruleset over to agents and translates it', () => {
    // The merge must take the whole entry: stripping it down to mode, system and
    // description would throw away the tool restrictions the reader chose.
    const path = openCodeConfigPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        agent: {
          morse: {
            mode: 'primary',
            model: 'acme/acme-chat',
            system: 'You are News Finder.',
            permissions: [
              { action: '*', resource: '*', effect: 'deny' },
              { action: 'read', resource: '*', effect: 'allow' },
              { action: 'bash', resource: '*', effect: 'allow' },
            ],
          },
        },
      }),
    );

    openCodeBotLayout.repair?.(botRoot);

    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(file['agent']).toBeUndefined();
    expect(file['agents']).toEqual({
      morse: {
        mode: 'primary',
        model: 'acme/acme-chat',
        system: 'You are News Finder.',
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'read', resource: '*', effect: 'allow' },
          { action: 'shell', resource: '*', effect: 'allow' },
          { action: 'external_directory', resource: '*', effect: 'allow' },
        ],
        instructions: [openCodeInstructionPath(botRoot)],
      },
    });
  });

  it('repairs a generated ruleset from the bash era and installs the plugin', () => {
    writeOpenCodeBotConfig(botRoot, { ...config, tools: ['read'] });
    const path = openCodeConfigPath(botRoot);
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    file.agents['morse']!['permissions'] = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'bash', resource: '*', effect: 'allow' },
      { action: 'list', resource: '*', effect: 'allow' },
    ];
    writeFileSync(path, JSON.stringify(file));

    openCodeBotLayout.repair?.(botRoot);

    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(repaired.agents['morse']?.['permissions']).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'allow' },
    ]);
    expect(existsSync(botUserSpacePluginPath(botRoot))).toBe(true);
  });

  it('leaves a hand-authored ruleset alone', () => {
    writeOpenCodeBotConfig(botRoot, config);
    const path = openCodeConfigPath(botRoot);
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    const rules = [
      { action: 'bash', resource: 'git *', effect: 'allow' },
      { action: 'read', resource: 'src/**', effect: 'allow' },
    ];
    file.agents['morse']!['permissions'] = rules;
    writeFileSync(path, JSON.stringify(file));

    openCodeBotLayout.repair?.(botRoot);

    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(repaired.agents['morse']?.['permissions']).toEqual(rules);
  });

  it('is idempotent across repairs', () => {
    writeOpenCodeBotConfig(botRoot, { ...config, tools: ['read', 'bash'] });
    const path = openCodeConfigPath(botRoot);
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    (file['agents'] as Record<string, Record<string, unknown>>)['morse']!['permissions'] = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'bash', resource: '*', effect: 'allow' },
    ];
    writeFileSync(path, JSON.stringify(file));

    openCodeBotLayout.repair?.(botRoot);
    const first = readFileSync(path, 'utf8');
    openCodeBotLayout.repair?.(botRoot);

    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  it('translates the wizard tools to OpenCode 2 permission actions', () => {
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      tools: ['read', 'bash', 'task', 'list', 'webfetch'],
    });

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(file.agents['morse']?.['permissions']).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'subagent', resource: '*', effect: 'allow' },
      { action: 'webfetch', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'allow' },
    ]);
    expect(openCodeBotLayout.read(botRoot).tools).toEqual([
      'read',
      'shell',
      'subagent',
      'webfetch',
    ]);
  });

  it('adds external access only when a file tool is chosen', () => {
    writeOpenCodeBotConfig(botRoot, { ...config, tools: ['shell'] });
    let file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(file.agents['morse']?.['permissions']).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'allow' },
    ]);

    writeOpenCodeBotConfig(botRoot, { ...config, tools: ['read'] });
    file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(file.agents['morse']?.['permissions']).toContainEqual({
      action: 'external_directory',
      resource: '*',
      effect: 'allow',
    });
    expect(openCodeBotLayout.read(botRoot).tools).toEqual(['read']);
  });

  it('keeps only the deny when no tools are chosen', () => {
    writeOpenCodeBotConfig(botRoot, { ...config, tools: [] });

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(file.agents['morse']?.['permissions']).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
    ]);
    expect(openCodeBotLayout.read(botRoot).tools).toEqual([]);
  });

  it('reads a legacy bash allow back as shell, without external_directory as a tool', () => {
    writeOpenCodeBotConfig(botRoot, config);
    const path = openCodeConfigPath(botRoot);
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      agents: Record<string, Record<string, unknown>>;
    };
    file.agents['morse']!['permissions'] = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'bash', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'allow' },
    ];
    writeFileSync(path, JSON.stringify(file));

    expect(openCodeBotLayout.read(botRoot).tools).toEqual(['shell']);
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
      // No `mcp` key still reads as an empty list, not as "unknown".
      mcpServers: [],
      // The bot's own provider, so its model limits can be corrected on an edit.
      providers: [
        {
          id: 'acme',
          label: 'Acme AI',
          api: 'openai-completions',
          baseUrl: 'https://llm.acme.example/v1',
          models: [
            { id: 'acme-chat', name: 'Acme Chat', contextWindow: 128_000, maxTokens: 8_192 },
          ],
        },
      ],
    });
  });

  it('writes the mcp block in OpenCode own shape and reads it back', () => {
    const mcpServers = [
      {
        name: 'filesystem',
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { ALLOWED_DIR: '/tmp' },
        cwd: '/tmp',
        enabled: false,
        exposure: 'deferred' as const,
      },
      {
        name: 'web',
        type: 'http' as const,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    ];

    writeOpenCodeBotConfig(botRoot, { ...config, mcpServers });

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(file.mcp).toEqual({
      filesystem: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.'],
        environment: { ALLOWED_DIR: '/tmp' },
        cwd: '/tmp',
        enabled: false,
      },
      web: {
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    });
    expect(openCodeBotLayout.read(botRoot).mcpServers).toEqual([
      {
        name: 'filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { ALLOWED_DIR: '/tmp' },
        cwd: '/tmp',
        enabled: false,
      },
      {
        name: 'web',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        enabled: true,
      },
    ]);
  });

  it('keeps unrelated keys and an mcp entry unknown field', () => {
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx', args: ['old'] }],
    });
    const path = openCodeConfigPath(botRoot);
    const before = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    (before['mcp'] as Record<string, Record<string, unknown>>)['fs']!['oauth'] = { kept: true };
    writeFileSync(path, JSON.stringify(before));

    writeOpenCodeBotConfig(botRoot, {
      ...config,
      mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx', args: ['new'] }],
    });

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(after['mcp']).toEqual({
      fs: { type: 'local', command: ['npx', 'new'], oauth: { kept: true } },
    });
    expect(after['username']).toBe('News Finder');
  });

  it('removes a server the form dropped and the mcp key when the list empties', () => {
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      mcpServers: [
        { name: 'fs', type: 'stdio', command: 'npx' },
        { name: 'web', type: 'http', url: 'https://example.com/mcp' },
      ],
    });

    const first = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(first.mcp).toEqual({
      fs: { type: 'local', command: ['npx'] },
      web: { type: 'remote', url: 'https://example.com/mcp' },
    });

    // A server the form dropped goes; the surviving one stays.
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx' }],
    });
    const second = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(second.mcp).toEqual({ fs: { type: 'local', command: ['npx'] } });

    // An empty list clears the block entirely, leaving the rest of the file.
    writeOpenCodeBotConfig(botRoot, { ...config, mcpServers: [] });
    const third = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(third['mcp']).toBeUndefined();
    expect(third['$schema']).toBe('https://opencode.ai/config.json');
  });

  it('leaves the mcp block alone when the caller does not mention MCP', () => {
    writeOpenCodeBotConfig(botRoot, {
      ...config,
      mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx' }],
    });

    writeOpenCodeBotConfig(botRoot, config);

    const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(file.mcp).toEqual({ fs: { type: 'local', command: ['npx'] } });
  });

  it('skips a malformed mcp entry while its sibling still reads', () => {
    const path = openCodeConfigPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcp: {
          bad: { type: 'remote' },
          good: { type: 'remote', url: 'https://example.com/mcp' },
        },
      }),
    );

    expect(openCodeBotLayout.read(botRoot).mcpServers).toEqual([
      { name: 'good', type: 'http', url: 'https://example.com/mcp', enabled: true },
    ]);
  });

  it('writes the bot config once, composing the mcp block beside every other section', () => {
    // A document OpenCode already holds: a key Morse does not own. The save has
    // to land the MCP block and everything Morse composes in one document — a
    // second writer for this path, or a stale snapshot, would lose the sections
    // that writer never read. The `description` is the field the shared codec
    // carries and the layout's own writer never did, so it proves the block came
    // from the store rather than a parallel implementation.
    const path = openCodeConfigPath(botRoot);
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(path, JSON.stringify({ plugins: ['keep-me'] }));

    writeOpenCodeBotConfig(botRoot, {
      ...config,
      mcpServers: [
        {
          name: 'notes',
          type: 'stdio',
          command: 'notes-mcp',
          args: ['--stdio'],
          description: 'Serves notes',
        },
        { name: 'web', type: 'http', url: 'https://notes.example/mcp' },
      ],
    });

    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(file['mcp']).toEqual({
      notes: { type: 'local', command: ['notes-mcp', '--stdio'], description: 'Serves notes' },
      web: { type: 'remote', url: 'https://notes.example/mcp' },
    });
    // Everything else the save composes is in the same document.
    expect(file['plugins']).toEqual(['keep-me']);
    expect(file['$schema']).toBe('https://opencode.ai/config.json');
    expect(file['username']).toBe('News Finder');
    expect(file['default_agent']).toBe(OPENCODE_BOT_AGENT);
    expect(file['model']).toBe('acme/acme-chat');
    expect(file['providers']).toMatchObject({ acme: { name: 'Acme AI' } });
    expect(file['agents']).toMatchObject({
      morse: { mode: 'primary', system: 'You are News Finder.' },
      reviewer: { mode: 'subagent' },
    });
    expect(file['instructions']).toEqual([join(botRoot, 'workspace', 'AGENTS.md')]);
  });

  it('aborts before writing when the existing config is corrupt', () => {
    // A save must not replace a config it cannot read: the reader's other keys
    // would be gone. The workspace document is a sentinel, because it is written
    // alongside the config and must not be touched by a save that aborts.
    const path = openCodeConfigPath(botRoot);
    const corrupt = '{\n  "username": "News Finder",\n  "mcp": {\n';
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(path, corrupt);
    const agentsPath = join(botRoot, 'workspace', 'AGENTS.md');
    mkdirSync(join(botRoot, 'workspace'), { recursive: true });
    writeFileSync(agentsPath, '# sentinel\n');

    expect(() => writeOpenCodeBotConfig(botRoot, config)).toThrow();

    expect(readFileSync(path, 'utf8')).toBe(corrupt);
    expect(readFileSync(agentsPath, 'utf8')).toBe('# sentinel\n');
  });
});
