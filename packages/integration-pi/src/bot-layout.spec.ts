import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotEngineConfig } from '@morse/system';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  piAgentDir,
  piBotLayout,
  piMcpPath,
  piSystemPromptPath,
  piWorkspacePath,
  writePiBotConfig,
} from './bot-layout.js';

/**
 * pi's own layout. `PI_CODING_AGENT_DIR` points at `<botRoot>/config`, so that
 * directory must be a 1:1 `~/.pi/agent`: `auth.json`, `models.json`,
 * `settings.json` and `AGENTS.md`, in the shapes pi itself writes.
 */
describe('piBotLayout', () => {
  let botRoot: string;

  beforeEach(() => {
    botRoot = mkdtempSync(join(tmpdir(), 'morse-pi-layout-'));
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
    credentials: [{ provider: 'zai', apiKey: 'zai-key' }],
    providers: [
      {
        id: 'acme',
        label: 'Acme AI',
        api: 'openai-completions',
        baseUrl: 'https://llm.acme.example/v1',
        credential: { kind: 'stored', apiKey: 'sk-acme' },
        models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 128_000 }],
      },
    ],
    model: { provider: 'zai', id: 'glm-5.3', name: 'GLM' },
    thinkingLevel: 'high',
  };

  const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

  it('writes the agent dir the bot runs with: config/, not a Morse shape', () => {
    writePiBotConfig(botRoot, config);

    expect(piAgentDir(botRoot)).toBe(join(botRoot, 'config'));
    expect(read(join(botRoot, 'config', 'auth.json'))).toEqual({
      zai: { type: 'api_key', key: 'zai-key' },
    });
    const settings = read(join(botRoot, 'config', 'settings.json')) as Record<string, unknown>;
    expect(Object.keys(settings)[0]).toBe('$schema');
    expect(settings['$schema']).toBe('https://pi.dev/schemas/settings.schema.json');
    expect(settings).toMatchObject({
      defaultProvider: 'zai',
      defaultModel: 'glm-5.3',
      defaultThinkingLevel: 'high',
    });
  });

  it('writes providers into models.json in pi own shape', () => {
    writePiBotConfig(botRoot, config);

    const models = read(join(botRoot, 'config', 'models.json')) as {
      providers: Record<string, unknown>;
    };
    expect(models.providers['acme']).toEqual({
      name: 'Acme AI',
      baseUrl: 'https://llm.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'sk-acme',
      models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 128_000 }],
    });
  });

  it('writes the model limits and modalities a reader corrected', () => {
    writePiBotConfig(botRoot, {
      ...config,
      providers: [
        {
          ...config.providers[0]!,
          models: [
            {
              id: 'vision-1',
              name: 'Vision One',
              contextWindow: 200_000,
              maxTokens: 8192,
              input: ['text', 'image'],
            },
          ],
        },
      ],
    });

    const models = read(join(botRoot, 'config', 'models.json')) as {
      providers: Record<string, { models: unknown[] }>;
    };
    // pi's own fields: a custom model's `input` defaults to ["text"], so a vision
    // model has to say `image` here or pi never sends one to it.
    expect(models.providers['acme']?.models).toEqual([
      {
        id: 'vision-1',
        name: 'Vision One',
        contextWindow: 200_000,
        maxTokens: 8192,
        input: ['text', 'image'],
      },
    ]);
  });

  it('corrects a model without costing the reader the key it never shows', () => {
    writePiBotConfig(botRoot, config);

    // What Edit bot sends: the provider read back from models.json, so no
    // credential and no api — the fields it corrected are the models.
    writePiBotConfig(botRoot, {
      ...config,
      credentials: [],
      providers: [
        {
          id: 'acme',
          label: 'Acme AI',
          models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 64_000 }],
        },
      ],
    });

    const models = read(join(botRoot, 'config', 'models.json')) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(models.providers['acme']).toEqual({
      name: 'Acme AI',
      baseUrl: 'https://llm.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'sk-acme',
      models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 64_000 }],
    });
  });

  it('reads the providers back, with the limits and modalities pi really has', () => {
    writePiBotConfig(botRoot, {
      ...config,
      providers: [
        {
          ...config.providers[0]!,
          models: [
            {
              id: 'vision-1',
              name: 'Vision One',
              contextWindow: 200_000,
              maxTokens: 8192,
              input: ['text', 'image'],
            },
            { id: 'plain', maxTokens: 4096 },
          ],
        },
      ],
    });

    const state = piBotLayout.read(botRoot);

    // The key is pi's, and is never read back: Edit bot shows the fields only.
    expect(state.providers).toEqual([
      {
        id: 'acme',
        label: 'Acme AI',
        api: 'openai-completions',
        baseUrl: 'https://llm.acme.example/v1',
        models: [
          {
            id: 'vision-1',
            name: 'Vision One',
            contextWindow: 200_000,
            maxTokens: 8192,
            input: ['text', 'image'],
          },
          { id: 'plain', maxTokens: 4096 },
        ],
      },
    ]);
  });

  it('says nothing about providers when the bot config declares none', () => {
    writePiBotConfig(botRoot, { ...config, providers: [] });

    expect(piBotLayout.read(botRoot).providers).toBeUndefined();
  });

  it('puts the persona in SYSTEM.md, where pi replaces its own system prompt', () => {
    writePiBotConfig(botRoot, config);

    // docs.pi.dev/latest/configuration: `<agent-dir>/SYSTEM.md` replaces Pi's
    // default system prompt, `APPEND_SYSTEM.md` adds to it, and `AGENTS.md` is
    // user instructions applied across working directories (appended context).
    // A bot's character is the system prompt, so it goes to SYSTEM.md.
    expect(readFileSync(piSystemPromptPath(botRoot), 'utf8')).toBe('You are News Finder.\n');
    expect(existsSync(join(botRoot, 'config', 'AGENTS.md'))).toBe(false);
    // The workspace document is a context file in the directory pi runs in.
    expect(readFileSync(piWorkspacePath(botRoot), 'utf8')).toBe('# workspace rules\n');
  });

  it('moves a persona an earlier Morse wrote to AGENTS.md into SYSTEM.md', () => {
    // What the previous layout left behind: the character in the appended-context
    // file, and no system prompt at all.
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(join(botRoot, 'config', 'AGENTS.md'), 'You are News Finder.\n');

    piBotLayout.repair?.(botRoot);

    expect(readFileSync(piSystemPromptPath(botRoot), 'utf8')).toBe('You are News Finder.\n');
    // Removed rather than copied: two copies would say the character twice.
    expect(existsSync(join(botRoot, 'config', 'AGENTS.md'))).toBe(false);
    expect(piBotLayout.read(botRoot).persona).toBe('You are News Finder.\n');
  });

  it('leaves a SYSTEM.md the reader wrote alone', () => {
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(join(botRoot, 'config', 'SYSTEM.md'), 'Hand-written.\n');
    writeFileSync(join(botRoot, 'config', 'AGENTS.md'), 'Older.\n');

    piBotLayout.repair?.(botRoot);

    expect(readFileSync(piSystemPromptPath(botRoot), 'utf8')).toBe('Hand-written.\n');
  });

  it('seeds the settings schema into an existing file and keeps the rest', () => {
    const agentDir = join(botRoot, 'config');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark', packages: [] }));
    writeFileSync(join(agentDir, 'AGENTS.md'), 'You are News Finder.\n');

    piBotLayout.repair?.(botRoot);

    const settings = read(join(agentDir, 'settings.json')) as Record<string, unknown>;
    expect(settings['$schema']).toBe('https://pi.dev/schemas/settings.schema.json');
    expect(settings['theme']).toBe('dark');
    expect(settings['packages']).toEqual([]);
    // The legacy persona move still runs in the same pass: seeding `$schema` must
    // not return early.
    expect(readFileSync(join(agentDir, 'SYSTEM.md'), 'utf8')).toBe('You are News Finder.\n');
  });

  it('does not create settings.json in repair', () => {
    const agentDir = join(botRoot, 'config');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), 'You are News Finder.\n');

    piBotLayout.repair?.(botRoot);

    expect(existsSync(join(agentDir, 'settings.json'))).toBe(false);
  });

  it('replaces a settings schema that is not pi, and keeps the rest', () => {
    const agentDir = join(botRoot, 'config');
    mkdirSync(agentDir, { recursive: true });
    // A file pointed at some other schema: the spread must not let that value
    // survive, or `repair` would rewrite the same wrong URL on every pass.
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ $schema: 'https://old.example/schema.json', theme: 'dark' }),
    );

    piBotLayout.repair?.(botRoot);

    const settings = read(join(agentDir, 'settings.json')) as Record<string, unknown>;
    expect(settings['$schema']).toBe('https://pi.dev/schemas/settings.schema.json');
    expect(Object.keys(settings)[0]).toBe('$schema');
    expect(settings['theme']).toBe('dark');
  });

  it('replaces a settings schema that is not pi when the wizard writes', () => {
    const agentDir = join(botRoot, 'config');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ $schema: 'https://old.example/schema.json', theme: 'dark' }),
    );

    writePiBotConfig(botRoot, config);

    const settings = read(join(agentDir, 'settings.json')) as Record<string, unknown>;
    expect(settings['$schema']).toBe('https://pi.dev/schemas/settings.schema.json');
    expect(Object.keys(settings)[0]).toBe('$schema');
    expect(settings['theme']).toBe('dark');
    expect(settings['defaultProvider']).toBe('zai');
  });

  it('keeps the reader settings it does not own, and clears what the form cleared', () => {
    const agentDir = join(botRoot, 'config');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', packages: [], defaultProvider: 'old', defaultModel: 'old' }),
    );
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({ providers: { hand: { api: 'openai-completions', models: [] } } }),
    );

    writePiBotConfig(botRoot, config);
    const settings = read(join(agentDir, 'settings.json')) as Record<string, unknown>;
    expect(settings['theme']).toBe('dark');
    expect(settings['defaultProvider']).toBe('zai');
    // The hand-added provider survives an edit that does not mention it.
    const models = read(join(agentDir, 'models.json')) as { providers: Record<string, unknown> };
    expect(models.providers['hand']).toBeDefined();

    // `null` clears the model; `undefined` keeps it (a caller that does not know
    // the choice must not reset the bot). The reader's theme survives both.
    writePiBotConfig(botRoot, { ...config, model: null, thinkingLevel: undefined });
    const cleared = read(join(agentDir, 'settings.json')) as Record<string, unknown>;
    expect(cleared['defaultProvider']).toBeUndefined();
    expect(cleared['defaultModel']).toBeUndefined();
    expect(cleared['defaultThinkingLevel']).toBeUndefined();
    expect(cleared['theme']).toBe('dark');
  });

  it('leaves the stored keys alone when the form collected none', () => {
    writePiBotConfig(botRoot, config);

    writePiBotConfig(botRoot, { ...config, credentials: [] });

    expect(read(join(botRoot, 'config', 'auth.json'))).toEqual({
      zai: { type: 'api_key', key: 'zai-key' },
    });
  });

  it('writes exactly the tools the reader chose, in pi own names', () => {
    writePiBotConfig(botRoot, { ...config, tools: ['read', 'bash'] });

    const settings = read(join(botRoot, 'config', 'settings.json')) as Record<string, unknown>;
    expect(settings['defaultTools']).toEqual(['read', 'bash']);
    expect(piBotLayout.read(botRoot).tools).toEqual(['read', 'bash']);

    // An empty list is "no tools", which is also what stops a provider that
    // emulates tools by asking for JSON from printing tool calls as chat.
    writePiBotConfig(botRoot, { ...config, tools: [] });
    const none = read(join(botRoot, 'config', 'settings.json')) as Record<string, unknown>;
    expect(none['defaultTools']).toEqual([]);
  });

  it('leaves the tool list alone when the caller does not mention it', () => {
    writePiBotConfig(botRoot, { ...config, tools: ['read'] });

    writePiBotConfig(botRoot, { ...config, tools: undefined });

    const settings = read(join(botRoot, 'config', 'settings.json')) as Record<string, unknown>;
    expect(settings['defaultTools']).toEqual(['read']);
  });

  it('keeps a stored model when the caller does not know it, and clears only on demand', () => {
    writePiBotConfig(botRoot, config);

    // A repair or a reconcile passes no model: it must not reset a working bot.
    writePiBotConfig(botRoot, { ...config, model: undefined, persona: 'Updated.' });
    let settings = read(join(botRoot, 'config', 'settings.json')) as Record<string, unknown>;
    expect(settings['defaultProvider']).toBe('zai');
    expect(settings['defaultModel']).toBe('glm-5.3');

    // An explicit null is the reader clearing the choice.
    writePiBotConfig(botRoot, { ...config, model: null });
    settings = read(join(botRoot, 'config', 'settings.json')) as Record<string, unknown>;
    expect(settings['defaultProvider']).toBeUndefined();
  });

  it('reads the configuration back for Edit bot', () => {
    writePiBotConfig(botRoot, config);

    expect(piBotLayout.read(botRoot)).toEqual({
      model: { provider: 'zai', id: 'glm-5.3', name: 'glm-5.3' },
      thinkingLevel: 'high',
      persona: 'You are News Finder.\n',
      agentsMd: '# workspace rules\n',
      // The bot's own provider, so its model limits can be corrected on an edit.
      providers: [
        {
          id: 'acme',
          label: 'Acme AI',
          api: 'openai-completions',
          baseUrl: 'https://llm.acme.example/v1',
          models: [{ id: 'acme-chat', name: 'Acme Chat', contextWindow: 128_000 }],
        },
      ],
    });
  });

  it('writes MCP servers into config/mcp.json in pi own shape and reads them back', () => {
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

    writePiBotConfig(botRoot, { ...config, mcpServers });

    expect(read(piMcpPath(botRoot))).toEqual({
      mcpServers: {
        filesystem: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { ALLOWED_DIR: '/tmp' },
          cwd: '/tmp',
          enabled: false,
          exposure: 'deferred',
        },
        web: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
    });
    expect(piBotLayout.read(botRoot).mcpServers).toEqual([
      mcpServers[0],
      { ...mcpServers[1], enabled: true },
    ]);
  });

  it('infers the transport of a hand-written entry without a type', () => {
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(
      piMcpPath(botRoot),
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['server'] },
          web: { url: 'https://example.com/mcp' },
        },
      }),
    );

    expect(piBotLayout.read(botRoot).mcpServers).toEqual([
      { name: 'fs', type: 'stdio', command: 'npx', args: ['server'], enabled: true },
      { name: 'web', type: 'http', url: 'https://example.com/mcp', enabled: true },
    ]);
  });

  it('keeps unknown fields and project overrides when rewriting servers', () => {
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(
      piMcpPath(botRoot),
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['old'], auth: { token: 'kept' } },
          fsOverride: { enabled: false, exposure: 'hidden' },
        },
      }),
    );

    writePiBotConfig(botRoot, {
      ...config,
      mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx', args: ['new'] }],
    });

    const file = read(piMcpPath(botRoot)) as { mcpServers: Record<string, unknown> };
    expect(file.mcpServers['fs']).toEqual({
      command: 'npx', args: ['new'], auth: { token: 'kept' }, type: 'stdio',
    });
    expect(file.mcpServers['fsOverride']).toEqual({ enabled: false, exposure: 'hidden' });
  });

  it('removes a server the form dropped and the key when the list empties', () => {
    writePiBotConfig(botRoot, { ...config, mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx' }] });
    writePiBotConfig(botRoot, { ...config, mcpServers: [] });

    expect(read(piMcpPath(botRoot))).toEqual({});
  });

  it('leaves mcp.json alone when the caller does not mention MCP', () => {
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(piMcpPath(botRoot), JSON.stringify({ mcpServers: { fs: { command: 'npx' } } }));

    writePiBotConfig(botRoot, config);

    expect(read(piMcpPath(botRoot))).toEqual({ mcpServers: { fs: { command: 'npx' } } });
  });

  it('fails before writing anything when mcp.json cannot be parsed', () => {
    // A bot someone already configured: every file here is a sentinel, and a
    // save that cannot finish must leave all of them exactly as they were.
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    mkdirSync(join(botRoot, 'workspace'), { recursive: true });
    const sentinels = new Map([
      [join(botRoot, 'config', 'auth.json'), '{"zai":{"type":"api_key","key":"old"}}\n'],
      [join(botRoot, 'config', 'models.json'), '{"providers":{"old":{"models":[]}}}\n'],
      [join(botRoot, 'config', 'settings.json'), '{"defaultModel":"old"}\n'],
      [piSystemPromptPath(botRoot), 'Old persona.\n'],
      [piWorkspacePath(botRoot), 'Old workspace rules.\n'],
    ]);
    for (const [path, text] of sentinels) {
      writeFileSync(path, text);
    }
    writeFileSync(piMcpPath(botRoot), '{ not json');

    expect(() =>
      writePiBotConfig(botRoot, {
        ...config,
        mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx' }],
      }),
    ).toThrow();

    // Not one write happened: no half-applied identity or config.
    for (const [path, text] of sentinels) {
      expect(readFileSync(path, 'utf8')).toBe(text);
    }
    expect(readFileSync(piMcpPath(botRoot), 'utf8')).toBe('{ not json');
  });

  it('a corrupt mcp.json does not hide the rest of the configuration', () => {
    writePiBotConfig(botRoot, config);
    writeFileSync(piMcpPath(botRoot), '{ not json');

    const state = piBotLayout.read(botRoot);
    expect(state.model).toEqual({ provider: 'zai', id: 'glm-5.3', name: 'glm-5.3' });
    expect(state.mcpServers).toBeUndefined();
  });

  it('ignores a null mcpServers entry instead of crashing the read', () => {
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(piMcpPath(botRoot), JSON.stringify({ mcpServers: { fs: null } }));

    expect(piBotLayout.read(botRoot).mcpServers).toEqual([]);
  });

  it('ignores non-object mcpServers entries and keeps the valid ones', () => {
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(
      piMcpPath(botRoot),
      JSON.stringify({
        mcpServers: {
          fs: null,
          arr: ['not', 'a', 'server'],
          web: { url: 'https://example.com/mcp' },
        },
      }),
    );

    expect(piBotLayout.read(botRoot).mcpServers).toEqual([
      { name: 'web', type: 'http', url: 'https://example.com/mcp', enabled: true },
    ]);
  });

  it('rewrites a file with null mcpServers entries without crashing', () => {
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(
      piMcpPath(botRoot),
      JSON.stringify({ mcpServers: { fs: null, web: { url: 'https://example.com/mcp' } } }),
    );

    writePiBotConfig(botRoot, {
      ...config,
      mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx' }],
    });

    expect(read(piMcpPath(botRoot))).toEqual({
      mcpServers: {
        fs: { type: 'stdio', command: 'npx' },
      },
    });
  });
});
