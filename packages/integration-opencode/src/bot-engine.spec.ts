import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentGateway } from '@morse/agent';
import { AgentUnavailableError, silentLogger } from '@morse/system';
import { OPENCODE_INSTALL_COMMAND } from './internal/connection.js';
import {
  OPENCODE_BOT_CAPABILITIES,
  botOpenCodeEnv,
  createBotOpenCodeEngine,
  opencodeBotAdapterFactory,
  writeOpenCodeCredentials,
  writeOpenCodeProviders,
  writeOpenCodeSubagents,
} from './bot-engine.js';
import type { BotProviderRecord } from '@morse/system';

/**
 * The bot engine's isolation is the point: every path OpenCode would resolve
 * from the user's own config or data directory is redirected into the bot's
 * tree, and the engine is one per bot because OpenCode has no
 * process-per-session to isolate. The factory test runs a fake `opencode
 * serve` against a fake HTTP server, because the caching it claims is about a
 * real spawned process, which a mock would hide.
 */

const WORKSPACE = { cwd: '/work/project', name: 'project' };
const PASSWORD = 'bot-password';

interface SessionRow {
  id: string;
  title?: string;
  time?: { created?: number; updated?: number };
  location?: { directory?: string };
}

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-bot-opencode-'));
  roots.push(dir);
  return dir;
}

/** Windows does not enforce POSIX mode bits; the assertion only means something elsewhere. */
function expectPrivateFile(path: string): void {
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
}

/** What `createBotOpenCodeEngine` forwards to a spawned server; the fake reads it. */
const ENV_KEYS = [
  'PATH',
  'FAKE_OC_URL',
  'FAKE_OC_PASSWORD',
  'FAKE_OC_SPAWNS',
  'FAKE_OC_STOP_FILE',
  'FAKE_OC_ENV_FILE',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * An `opencode serve` stand-in, put first on `PATH` under the name the engine
 * resolves: it announces the fake server's address, counts its own launches,
 * and records the XDG roots it was handed — that marker is what proves the
 * spawn actually received the bot's isolation environment. SIGTERM writes a
 * stop marker, so a disposed engine is seen to stop the process it owned.
 */
function fakeBinary(dir: string): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, 'opencode');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_OC_SPAWNS, 'spawn\\n');
fs.writeFileSync(
  process.env.FAKE_OC_ENV_FILE,
  JSON.stringify({ config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME }),
);
process.on('SIGTERM', () => {
  fs.writeFileSync(process.env.FAKE_OC_STOP_FILE, 'stopped');
  process.exit(0);
});
console.log('server listening on ' + process.env.FAKE_OC_URL);
console.log('server password ' + process.env.FAKE_OC_PASSWORD);
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return binDir;
}

function spawnCount(botRoot: string): number {
  const path = join(botRoot, 'spawns.log');
  if (!existsSync(path)) {
    return 0;
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0).length;
}

/** A fake OpenCode v2 server: the probe, reattach reads, and a session create. */
async function startFakeServer(): Promise<{
  url: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const sessions = new Map<string, SessionRow>([
    [
      'ses_1',
      {
        id: 'ses_1',
        title: 'First',
        time: { created: 1_000, updated: 2_000 },
        location: { directory: WORKSPACE.cwd },
      },
    ],
    [
      'ses_2',
      {
        id: 'ses_2',
        title: 'Second',
        time: { created: 3_000, updated: 4_000 },
        location: { directory: WORKSPACE.cwd },
      },
    ],
  ]);
  const expected = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  const send = (response: ServerResponse, body: unknown, status = 200): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`);
    if (request.headers.authorization !== expected) {
      send(response, { error: 'unauthorized' }, 401);
      return;
    }
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    if (path === '/api/event') {
      // A stream that ends at once is enough: the agent only needs a subscription.
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end();
      return;
    }
    if (path === '/api/session' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        const parsed =
          body.length === 0 ? {} : (JSON.parse(body) as { location?: { directory?: string } });
        const session: SessionRow = {
          id: 'ses_new',
          title: 'New',
          time: { created: 5_000, updated: 5_000 },
          location: parsed.location,
        };
        sessions.set(session.id, session);
        send(response, { data: session });
      });
      return;
    }
    if (path === '/api/session') {
      send(response, { data: [...sessions.values()] });
      return;
    }
    const attach = /^\/api\/session\/([^/]+)(?:\/(form|permission))?$/.exec(path);
    if (attach !== null) {
      const id = decodeURIComponent(attach[1]!);
      if (attach[2] !== undefined) {
        send(response, { data: [] });
        return;
      }
      const session = sessions.get(id);
      if (session === undefined) {
        send(response, { _tag: 'NotFound', message: `no session ${id}` }, 404);
        return;
      }
      send(response, { data: session });
      return;
    }
    if (path === '/api/model') {
      send(response, {
        data: [
          {
            id: 'flint-40b-free',
            providerID: 'opencode',
            name: 'Flint 40B Free',
            variants: [{ id: 'low' }],
          },
        ],
      });
      return;
    }
    if (path === '/api/model/default') {
      send(response, { data: { id: 'flint-40b-free', providerID: 'opencode' } });
      return;
    }
    // Catalogs and pending interactions: empty is a valid answer everywhere.
    send(response, { data: [] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('botOpenCodeEnv', () => {
  it('points both XDG roots at the bot and keeps the base environment', () => {
    const botRoot = tempRoot();

    const env = botOpenCodeEnv(botRoot, { PATH: '/usr/bin', HOME: '/home/u' });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      XDG_CONFIG_HOME: join(botRoot, 'config'),
      XDG_DATA_HOME: join(botRoot, 'sessions'),
    });
  });

  it('overrides XDG roots inherited from the base environment', () => {
    // A host launched from inside a user's OpenCode session carries that user's
    // XDG dirs; a bot must never read or write them.
    const botRoot = tempRoot();

    const env = botOpenCodeEnv(botRoot, {
      PATH: '/usr/bin',
      XDG_CONFIG_HOME: '/home/u/.config',
      XDG_DATA_HOME: '/home/u/.local/share',
    });

    expect(env['XDG_CONFIG_HOME']).toBe(join(botRoot, 'config'));
    expect(env['XDG_DATA_HOME']).toBe(join(botRoot, 'sessions'));
  });

  it('defaults to the host environment and does not mutate it', () => {
    const botRoot = tempRoot();

    const env = botOpenCodeEnv(botRoot);

    expect(env['XDG_CONFIG_HOME']).toBe(join(botRoot, 'config'));
    expect(env['XDG_DATA_HOME']).toBe(join(botRoot, 'sessions'));
    // The full env matters: the spawn needs PATH to find the binary.
    expect(env['PATH']).toBe(process.env['PATH']);

    const base = { PATH: '/usr/bin' };
    botOpenCodeEnv(botRoot, base);
    expect(base).toEqual({ PATH: '/usr/bin' });
  });
});

describe('OPENCODE_BOT_CAPABILITIES', () => {
  it('declares a subagent-capable, thinking-level engine with stored credentials', () => {
    expect(OPENCODE_BOT_CAPABILITIES).toEqual({
      supportsSubagents: true,
      supportsThinkingLevels: true,
      credentials: 'stored',
    });
  });
});

describe('writeOpenCodeCredentials', () => {
  it("writes OpenCode's auth file at its data dir inside the bot, mode 0600", () => {
    const botRoot = tempRoot();

    writeOpenCodeCredentials(botRoot, [{ provider: 'anthropic', apiKey: 'sk-ant' }]);

    // XDG_DATA_HOME is <botRoot>/sessions and OpenCode nests its data under
    // `opencode/`, so its native auth.json lands here.
    const path = join(botRoot, 'sessions', 'opencode', 'auth.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      anthropic: { type: 'api', key: 'sk-ant' },
    });
    expectPrivateFile(path);
  });

  it('writes several providers and replaces the file whole on a second call', () => {
    const botRoot = tempRoot();
    writeOpenCodeCredentials(botRoot, [
      { provider: 'anthropic', apiKey: 'sk-old' },
      { provider: 'openai', apiKey: 'sk-openai' },
    ]);

    writeOpenCodeCredentials(botRoot, [{ provider: 'anthropic', apiKey: 'sk-new' }]);

    const dir = join(botRoot, 'sessions', 'opencode');
    const path = join(dir, 'auth.json');
    // A provider the wizard no longer lists must disappear, not linger with an
    // old key.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      anthropic: { type: 'api', key: 'sk-new' },
    });
    expectPrivateFile(path);
    // The atomic write leaves no temp file beside the secret.
    expect(readdirSync(dir)).toEqual(['auth.json']);
  });

  it('creates the bot data dir when it does not exist yet', () => {
    const botRoot = tempRoot();

    writeOpenCodeCredentials(botRoot, [{ provider: 'anthropic', apiKey: 'sk' }]);

    expect(readdirSync(join(botRoot, 'sessions'))).toEqual(['opencode']);
  });
});

describe('writeOpenCodeProviders', () => {
  const configPath = (botRoot: string): string =>
    join(botRoot, 'config', 'opencode', 'opencode.json');

  function provider(overrides: Partial<BotProviderRecord> = {}): BotProviderRecord {
    return {
      id: 'acme',
      label: 'Acme',
      api: 'openai-completions',
      baseUrl: 'https://llm.acme.example/v1',
      credential: { kind: 'stored', apiKey: 'sk-acme' },
      models: [{ id: 'qwen3-coder', name: 'Qwen 3 Coder' }],
      ...overrides,
    };
  }

  it('writes the runtime package, baseURL, key and models map into the bot config', () => {
    const botRoot = tempRoot();
    writeOpenCodeProviders(botRoot, [provider()]);
    const config = JSON.parse(readFileSync(configPath(botRoot), 'utf8'));
    expect(config.providers.acme).toEqual({
      name: 'Acme',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'https://llm.acme.example/v1', apiKey: 'sk-acme' },
      models: { 'qwen3-coder': { name: 'Qwen 3 Coder' } },
    });
  });

  it('maps each wire protocol to its runtime package and env credentials to env', () => {
    const botRoot = tempRoot();
    writeOpenCodeProviders(botRoot, [
      provider({ id: 'a', api: 'openai-responses', models: [{ id: 'x' }] }),
      provider({ id: 'b', api: 'anthropic-messages', models: [{ id: 'x' }] }),
      provider({ id: 'c', api: 'google-generative-ai', models: [{ id: 'x' }] }),
      provider({ id: 'd', credential: { kind: 'env', name: 'ACME_API_KEY' }, models: [{ id: 'x' }] }),
    ]);
    const config = JSON.parse(readFileSync(configPath(botRoot), 'utf8'));
    expect(config.providers.a.package).toBe('@opencode/ai/providers/openai-compatible/responses');
    expect(config.providers.b.package).toBe('@opencode/ai/providers/anthropic-compatible');
    expect(config.providers.c.package).toBe('@opencode/ai/providers/google');
    expect(config.providers.d.env).toEqual(['ACME_API_KEY']);
    expect(config.providers.d.settings.apiKey).toBeUndefined();
  });

  it('merges with existing config (MCP, other providers) and skips catalog providers', () => {
    const botRoot = tempRoot();
    mkdirSync(join(botRoot, 'config', 'opencode'), { recursive: true });
    writeFileSync(
      configPath(botRoot),
      JSON.stringify({ mcp: { filesystem: {} }, providers: { kept: { name: 'Kept' } } }),
    );
    writeOpenCodeProviders(botRoot, [
      provider(),
      provider({ id: 'catalog', baseUrl: undefined, models: [{ id: 'x' }] }),
    ]);
    const config = JSON.parse(readFileSync(configPath(botRoot), 'utf8'));
    expect(config.mcp).toEqual({ filesystem: {} });
    expect(config.providers.kept).toEqual({ name: 'Kept' });
    expect(config.providers.catalog).toBeUndefined();
    expect(config.providers.acme.models).toEqual({ 'qwen3-coder': { name: 'Qwen 3 Coder' } });
  });
});

describe('writeOpenCodeSubagents', () => {
  /** The bot's own OpenCode config: XDG_CONFIG_HOME (`<botRoot>/config`) + `opencode`. */
  const configPath = (botRoot: string): string =>
    join(botRoot, 'config', 'opencode', 'opencode.json');

  function configDir(botRoot: string): string {
    return join(botRoot, 'config', 'opencode');
  }

  it("creates the agent entries in the bot's own OpenCode config", () => {
    const botRoot = tempRoot();

    writeOpenCodeSubagents(botRoot, [
      { name: 'reviewer', prompt: 'Read the diff and report risks.\nThen stay quiet.' },
    ]);

    // The first line becomes the description OpenCode shows for the agent; the
    // whole prompt stays the agent's system prompt.
    expect(JSON.parse(readFileSync(configPath(botRoot), 'utf8'))).toEqual({
      agent: {
        reviewer: {
          mode: 'subagent',
          description: 'Read the diff and report risks.',
          prompt: 'Read the diff and report risks.\nThen stay quiet.',
        },
      },
    });
  });

  it('preserves the mcp section and every other key the file already carries', () => {
    const botRoot = tempRoot();
    mkdirSync(configDir(botRoot), { recursive: true });
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      mcp: { bot_one: { type: 'local', command: ['npx', '-y', 'one'] } },
      model: 'anthropic/claude-sonnet-4',
      agent: { builder: { mode: 'primary', prompt: 'Build.' } },
    };
    writeFileSync(configPath(botRoot), JSON.stringify(existing));

    writeOpenCodeSubagents(botRoot, [{ name: 'reviewer', prompt: 'Review.' }]);

    const written = JSON.parse(readFileSync(configPath(botRoot), 'utf8')) as {
      mcp: unknown;
      agent: Record<string, unknown>;
    };
    // One file carries the bot's MCP servers, model and agents: a subagent write
    // may add to `agent` and must not touch anything else.
    expect(written.mcp).toEqual(existing.mcp);
    expect(written).toMatchObject({
      $schema: existing.$schema,
      model: existing.model,
    });
    expect(written.agent['builder']).toEqual(existing.agent.builder);
    expect(written.agent['reviewer']).toMatchObject({
      mode: 'subagent',
      description: 'Review.',
      prompt: 'Review.',
    });
  });

  it('upserts a second call instead of duplicating the agent', () => {
    const botRoot = tempRoot();
    writeOpenCodeSubagents(botRoot, [{ name: 'reviewer', prompt: 'Review.' }]);

    writeOpenCodeSubagents(botRoot, [{ name: 'reviewer', prompt: 'Review harder.' }]);

    const written = JSON.parse(readFileSync(configPath(botRoot), 'utf8')) as {
      agent: Record<string, unknown>;
    };
    expect(Object.keys(written.agent)).toEqual(['reviewer']);
    expect(written.agent['reviewer']).toEqual({
      mode: 'subagent',
      description: 'Review harder.',
      prompt: 'Review harder.',
    });
  });

  it('caps the description at 80 characters and falls back to the name', () => {
    const botRoot = tempRoot();
    // A name is already a label OpenCode shows whole; only the prompt line is
    // capped, so a long name is not truncated into something unreadable.
    const longName = 'n'.repeat(90);

    writeOpenCodeSubagents(botRoot, [
      { name: 'long-winded', prompt: `${'a'.repeat(120)}\nsecond line` },
      { name: 'blank', prompt: '   ' },
      { name: longName, prompt: '' },
    ]);

    const { agent } = JSON.parse(readFileSync(configPath(botRoot), 'utf8')) as {
      agent: Record<string, { description: string; prompt: string }>;
    };
    expect(agent['long-winded']?.description).toBe('a'.repeat(80));
    // A prompt with no usable first line still needs a description OpenCode can
    // show, and the name is the only honest one.
    expect(agent['blank']?.description).toBe('blank');
    expect(agent['blank']?.prompt).toBe('   ');
    expect(agent[longName]?.description).toBe(longName);
  });

  it('writes a subagent named __proto__ as a plain key', () => {
    const botRoot = tempRoot();

    // `__proto__` is a legal agent name here, but assigning it on an ordinary
    // object hits the prototype setter and the entry never reaches the file.
    writeOpenCodeSubagents(botRoot, [{ name: '__proto__', prompt: 'Watch the prototype.' }]);

    const written = JSON.parse(readFileSync(configPath(botRoot), 'utf8')) as {
      agent: Record<string, unknown>;
    };
    expect(Object.keys(written.agent)).toContain('__proto__');
    expect(written.agent['__proto__']).toEqual({
      mode: 'subagent',
      description: 'Watch the prototype.',
      prompt: 'Watch the prototype.',
    });
  });

  it('leaves no temp file beside the config', () => {
    const botRoot = tempRoot();

    writeOpenCodeSubagents(botRoot, [{ name: 'reviewer', prompt: 'Review.' }]);

    expect(readdirSync(configDir(botRoot))).toEqual(['opencode.json']);
  });

  it('refuses an agent section that is not an object', () => {
    const botRoot = tempRoot();
    mkdirSync(configDir(botRoot), { recursive: true });
    writeFileSync(configPath(botRoot), JSON.stringify({ agent: ['not', 'an', 'object'] }));

    expect(() =>
      writeOpenCodeSubagents(botRoot, [{ name: 'reviewer', prompt: 'Review.' }]),
    ).toThrow(/"agent" must be an object/);
  });
});

describe('createBotOpenCodeEngine', () => {
  it('reports a binary it cannot execute as an unavailable agent, with the reason', async () => {
    const botRoot = tempRoot();
    const bin = join(botRoot, 'not-executable');
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 });

    const error: unknown = await createBotOpenCodeEngine({
      botRoot,
      bin,
      logger: silentLogger,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as Error).message).toContain(bin);
    expect((error as Error).message).toMatch(/could not start/i);
  });

  it("passes a dead server's own stderr through instead of a generic failure", async () => {
    const botRoot = tempRoot();
    const bin = join(botRoot, 'failing-opencode');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
console.error('bind: address already in use');
process.exit(3);
`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);

    const error: unknown = await createBotOpenCodeEngine({
      botRoot,
      bin,
      logger: silentLogger,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as Error).message).toContain('address already in use');
  });

  it('pins MCP and command administration to the config dir the server reads', async () => {
    const botRoot = tempRoot();
    const fake = await startFakeServer();
    process.env['PATH'] = `${fakeBinary(botRoot)}${delimiter}${process.env['PATH'] ?? ''}`;
    process.env['FAKE_OC_URL'] = fake.url;
    process.env['FAKE_OC_PASSWORD'] = PASSWORD;
    process.env['FAKE_OC_SPAWNS'] = join(botRoot, 'spawns.log');
    process.env['FAKE_OC_ENV_FILE'] = join(botRoot, 'env.json');
    const engine = await createBotOpenCodeEngine({ botRoot, logger: silentLogger });
    try {
      // The server resolves its config from XDG_CONFIG_HOME + `opencode`, so an
      // admin write must land exactly there — one level below the XDG base.
      const configDir = join(botOpenCodeEnv(botRoot)['XDG_CONFIG_HOME']!, 'opencode');
      const mutation = (await engine.extras!.mcp!.add(
        { name: 'bot_one', command: 'npx', args: ['-y', 'one'] },
        WORKSPACE.cwd,
      )) as { ok: boolean; path?: string };
      expect(mutation.ok).toBe(true);
      expect(mutation.path).toBe(join(configDir, 'opencode.json'));
      const written = JSON.parse(readFileSync(join(configDir, 'opencode.json'), 'utf8')) as {
        mcp?: Record<string, unknown>;
      };
      expect(written.mcp?.['bot_one']).toMatchObject({
        type: 'local',
        command: ['npx', '-y', 'one'],
      });

      const listed = (await engine.extras!.prompts!.list(WORKSPACE.cwd)) as {
        globalDir: string;
        configPath: string;
      };
      expect(listed.globalDir).toBe(join(configDir, 'commands'));
      expect(listed.configPath).toBe(join(configDir, 'opencode.json'));
    } finally {
      await engine.dispose();
      await fake.close();
    }
  });

  it('names a missing binary and keeps the install remedy', async () => {
    const botRoot = tempRoot();

    const error: unknown = await createBotOpenCodeEngine({
      botRoot,
      bin: join(botRoot, 'absent'),
      logger: silentLogger,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as AgentUnavailableError).remedy?.install).toBe(OPENCODE_INSTALL_COMMAND);
  });
});

describe('opencodeBotAdapterFactory', () => {
  it('keeps one engine per bot, reattaches sessions through it, and stops it on dispose', async () => {
    const botRoot = tempRoot();
    const fake = await startFakeServer();
    process.env['PATH'] = `${fakeBinary(botRoot)}${delimiter}${process.env['PATH'] ?? ''}`;
    process.env['FAKE_OC_URL'] = fake.url;
    process.env['FAKE_OC_PASSWORD'] = PASSWORD;
    process.env['FAKE_OC_SPAWNS'] = join(botRoot, 'spawns.log');
    process.env['FAKE_OC_STOP_FILE'] = join(botRoot, 'stopped');
    process.env['FAKE_OC_ENV_FILE'] = join(botRoot, 'env.json');
    const factory = opencodeBotAdapterFactory(botRoot, silentLogger);
    const gateways: AgentGateway[] = [];
    try {
      // Two reattached sessions share the one engine, so one server.
      const first = await factory.create({ workspace: WORKSPACE, sessionId: 'ses_1' });
      const second = await factory.create({ workspace: WORKSPACE, sessionId: 'ses_2' });
      gateways.push(first, second);
      // The spawned server really received the bot's XDG roots; without them it
      // would read and write the user's own config and sessions.
      expect(JSON.parse(readFileSync(join(botRoot, 'env.json'), 'utf8'))).toEqual({
        config: join(botRoot, 'config'),
        data: join(botRoot, 'sessions'),
      });
      expect(first).not.toBe(second);
      expect((await first.state()).sessionId).toBe('ses_1');
      expect((await second.state()).sessionId).toBe('ses_2');
      expect(fake.requests).toContain('GET /api/session/ses_1');
      expect(fake.requests).toContain('GET /api/session/ses_2');

      // A session without an id is created by the same engine, not a new one.
      const fresh = await factory.create({ workspace: WORKSPACE });
      gateways.push(fresh);
      expect((await fresh.state()).sessionId).toBe('ses_new');
      expect(fake.requests.filter((request) => request === 'POST /api/session')).toHaveLength(1);

      expect(spawnCount(botRoot)).toBe(1);

      for (const gateway of gateways.splice(0)) {
        await gateway.dispose();
      }
      await factory.dispose();
      // The engine owned the server it spawned, so disposing it stopped it.
      expect(existsSync(join(botRoot, 'stopped'))).toBe(true);
      expect(spawnCount(botRoot)).toBe(1);

      // Disposal is final: a late create is told the engine is gone rather than
      // quietly spawning a second server.
      await expect(factory.create({ workspace: WORKSPACE })).rejects.toBeInstanceOf(
        AgentUnavailableError,
      );
      expect(spawnCount(botRoot)).toBe(1);
    } finally {
      for (const gateway of gateways.splice(0)) {
        await gateway.dispose().catch(() => undefined);
      }
      await factory.dispose().catch(() => undefined);
      await fake.close();
    }
  }, 20_000);
});
