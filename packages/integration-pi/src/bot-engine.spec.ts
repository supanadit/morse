import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@morse/system';
import { PiRpcAgentFactory } from './pi-rpc-agent-factory.js';
import { PI_INSTALL_COMMAND } from './internal/resolve-pi.js';
import {
  PI_BOT_CAPABILITIES,
  PI_INSTALL_HINT,
  botPiEnv,
  createBotPiFactory,
  importPiGlobalConfig,
  writePiCredentials,
  writePiProviders,
} from './bot-engine.js';
import type { BotProviderRecord } from '@morse/system';

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-bot-pi-'));
  roots.push(dir);
  return dir;
}

/**
 * Windows does not enforce POSIX mode bits: `stat` reports a fixed mode for
 * every file, so the private-file assertion only means something elsewhere.
 */
function expectPrivateFile(path: string): void {
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('botPiEnv', () => {
  it('points pi at the bot config dir and keeps the base environment', () => {
    const botRoot = tempRoot();

    const env = botPiEnv(botRoot, {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/u',
      MORSE_PI_PATH: '/opt/pi',
    });

    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/u',
      MORSE_PI_PATH: '/opt/pi',
      PI_CODING_AGENT_DIR: join(botRoot, 'config'),
    });
  });

  it('overrides an agent dir inherited from the base environment', () => {
    // A host started from inside pi carries the user's real agent dir; a bot
    // must never read or write it.
    const botRoot = tempRoot();

    const env = botPiEnv(botRoot, {
      PATH: '/usr/bin',
      PI_CODING_AGENT_DIR: '/home/u/.pi/agent',
    });

    expect(env.PI_CODING_AGENT_DIR).toBe(join(botRoot, 'config'));
    expect(env.PATH).toBe('/usr/bin');
  });

  it('defaults to the host environment', () => {
    const botRoot = tempRoot();

    const env = botPiEnv(botRoot);

    expect(env.PI_CODING_AGENT_DIR).toBe(join(botRoot, 'config'));
    // The full env matters: `resolvePi` finds MORSE_PI_PATH and PATH in it.
    expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it('does not mutate the base environment', () => {
    const base = { PATH: '/usr/bin' };

    botPiEnv(tempRoot(), base);

    expect(base).toEqual({ PATH: '/usr/bin' });
  });
});

describe('PI_BOT_CAPABILITIES', () => {
  it('declares a stored-credential engine with thinking levels and no subagents', () => {
    expect(PI_BOT_CAPABILITIES).toEqual({
      supportsSubagents: false,
      supportsThinkingLevels: true,
      credentials: 'stored',
    });
  });
});

describe('createBotPiFactory', () => {
  it('builds a pi factory that can create gateways', () => {
    const factory = createBotPiFactory({
      botRoot: tempRoot(),
      env: { PATH: '/usr/bin', MORSE_PI_PATH: '/opt/pi' },
      piPath: '/opt/pi',
      logger: silentLogger,
    });

    expect(factory).toBeInstanceOf(PiRpcAgentFactory);
    expect(typeof factory.create).toBe('function');
  });

  it('removes one session file by its stored id', async () => {
    const botRoot = tempRoot();
    const sessionPath = join(botRoot, 'sessions', '--work--', 'session-1.jsonl');
    mkdirSync(join(botRoot, 'sessions', '--work--'), { recursive: true });
    writeFileSync(sessionPath, '{}\n');
    const factory = createBotPiFactory({
      botRoot,
      env: { PATH: '/usr/bin' },
      piPath: '/opt/pi',
      logger: silentLogger,
    });

    await factory.removeSession(sessionPath);

    expect(existsSync(sessionPath)).toBe(false);
  });
});

describe('PI_INSTALL_HINT', () => {
  it('re-exports the install command the wizard offers', () => {
    expect(PI_INSTALL_HINT).toBe(PI_INSTALL_COMMAND);
  });
});

describe('writePiProviders', () => {
  function provider(overrides: Partial<BotProviderRecord> = {}): BotProviderRecord {
    return {
      id: 'acme',
      label: 'Acme',
      api: 'openai-completions',
      baseUrl: 'https://llm.acme.example/v1',
      credential: { kind: 'stored', apiKey: 'sk-acme' },
      models: [{ id: 'qwen3-coder', name: 'Qwen 3 Coder', contextWindow: 128000 }],
      ...overrides,
    };
  }

  it('writes baseUrl, api, key and a models array into the bot config models.json', () => {
    const botRoot = tempRoot();
    writePiProviders(botRoot, [provider()]);
    const config = JSON.parse(readFileSync(join(botRoot, 'config', 'models.json'), 'utf8'));
    expect(config.providers.acme).toEqual({
      // pi's own provider display name, kept so Edit bot can show the label.
      name: 'Acme',
      baseUrl: 'https://llm.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'sk-acme',
      models: [{ id: 'qwen3-coder', name: 'Qwen 3 Coder', contextWindow: 128000 }],
    });
  });

  it('references env credentials with pi’s $NAME convention', () => {
    const botRoot = tempRoot();
    writePiProviders(botRoot, [provider({ credential: { kind: 'env', name: 'ACME_API_KEY' } })]);
    const config = JSON.parse(readFileSync(join(botRoot, 'config', 'models.json'), 'utf8'));
    expect(config.providers.acme.apiKey).toBe('$ACME_API_KEY');
  });

  it('merges with existing providers and unknown keys, private as auth.json', () => {
    const botRoot = tempRoot();
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(
      join(botRoot, 'config', 'models.json'),
      JSON.stringify({ providers: { anthropic: { baseUrl: 'https://api.anthropic.com' } }, version: 1 }),
    );
    writePiProviders(botRoot, [provider()]);
    const path = join(botRoot, 'config', 'models.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.version).toBe(1);
    expect(config.providers.anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(config.providers.acme.models).toHaveLength(1);
    expectPrivateFile(path);
  });
});

describe('writePiCredentials', () => {
  it('writes pi auth.json in the bot config dir with mode 0600', () => {
    const botRoot = tempRoot();

    writePiCredentials(botRoot, [{ provider: 'anthropic', apiKey: 'sk' }]);

    const path = join(botRoot, 'config', 'auth.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      anthropic: { type: 'api_key', key: 'sk' },
    });
    expectPrivateFile(path);
  });

  it('creates the config dir when it does not exist yet', () => {
    const botRoot = tempRoot();

    writePiCredentials(botRoot, [{ provider: 'anthropic', apiKey: 'sk' }]);

    expect(readdirSync(join(botRoot, 'config'))).toEqual(['auth.json']);
  });

  it('replaces the file on a second call and keeps it private', () => {
    const botRoot = tempRoot();
    writePiCredentials(botRoot, [
      { provider: 'anthropic', apiKey: 'sk-old' },
      { provider: 'openai', apiKey: 'sk-openai' },
    ]);

    writePiCredentials(botRoot, [{ provider: 'anthropic', apiKey: 'sk-new' }]);

    const configDir = join(botRoot, 'config');
    const path = join(configDir, 'auth.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      anthropic: { type: 'api_key', key: 'sk-new' },
    });
    expectPrivateFile(path);
    // The atomic write leaves no temp file beside the secret.
    expect(readdirSync(configDir)).toEqual(['auth.json']);
  });
});

/**
 * The global-configuration snapshot: the machine's own `auth.json` entries
 * and `models.json` providers land in the bot, and the bot wins on conflict.
 */
describe('importPiGlobalConfig', () => {
  let previousAgentDir: string | undefined;
  let previousKey: string | undefined;

  function withGlobalDir(dir: string): void {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
  }

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    previousAgentDir = undefined;
    if (previousKey === undefined) {
      delete process.env.MORSE_TEST_ACME_KEY;
    } else {
      process.env.MORSE_TEST_ACME_KEY = previousKey;
    }
    previousKey = undefined;
  });

  const readJson = (path: string): unknown =>
    JSON.parse(readFileSync(path, 'utf8') as string);

  it('copies global keys and providers, bot wins on conflict', () => {
    const globalDir = tempRoot();
    const botRoot = tempRoot();
    withGlobalDir(globalDir);
    writeFileSync(
      join(globalDir, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'api_key', key: 'global-anthropic' },
        openai: { type: 'api_key', key: 'global-openai' },
      }),
    );
    writeFileSync(
      join(globalDir, 'models.json'),
      JSON.stringify({
        providers: {
          acme: {
            name: 'Acme AI',
            baseUrl: 'https://llm.acme.example/v1',
            api: 'openai-completions',
            apiKey: 'global-acme',
            models: [{ id: 'acme-chat' }],
          },
          shared: { name: 'Shared', models: [{ id: 's' }] },
        },
      })
    );
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    writeFileSync(
      join(botRoot, 'config', 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'bot-anthropic' } })
    );
    writeFileSync(
      join(botRoot, 'config', 'models.json'),
      JSON.stringify({ providers: { mine: { name: 'Mine', models: [{ id: 'm' }] } } })
    );

    expect(importPiGlobalConfig(botRoot)).toBe(true);

    // The bot's own key wins; the global-only key joins it.
    expect(readJson(join(botRoot, 'config', 'auth.json'))).toEqual({
      anthropic: { type: 'api_key', key: 'bot-anthropic' },
      openai: { type: 'api_key', key: 'global-openai' },
    });
    // The bot's own providers survive; missing global ones arrive verbatim.
    const providers = (
      readJson(join(botRoot, 'config', 'models.json')) as {
        providers: Record<string, unknown>;
      }
    ).providers;
    expect(Object.keys(providers).sort()).toEqual(['acme', 'mine', 'shared']);
    expect(providers['acme']).toEqual({
      name: 'Acme AI',
      baseUrl: 'https://llm.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'global-acme',
      models: [{ id: 'acme-chat' }],
    });
  });

  it('succeeds with nothing to copy when the machine holds no pi config', () => {
    const botRoot = tempRoot();
    withGlobalDir(join(botRoot, 'no-global-here'));
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    expect(importPiGlobalConfig(botRoot)).toBe(true);
    expect(readJson(join(botRoot, 'config', 'auth.json'))).toEqual({});
  });

  it('resolves env-referenced keys, fills a clone’s empty key, keeps a typed one', () => {
    const globalDir = tempRoot();
    const botRoot = tempRoot();
    withGlobalDir(globalDir);
    previousKey = process.env.MORSE_TEST_ACME_KEY;
    process.env.MORSE_TEST_ACME_KEY = 'raw-acme';
    writeFileSync(
      join(globalDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: '${MORSE_TEST_ACME_KEY}' } }),
    );
    writeFileSync(
      join(globalDir, 'models.json'),
      JSON.stringify({
        providers: {
          acme: {
            name: 'Acme AI',
            baseUrl: 'https://llm.acme.example/v1',
            apiKey: '$MORSE_TEST_ACME_KEY',
            models: [{ id: 'acme-chat' }],
          },
          missing: { name: 'Missing', apiKey: '$MORSE_TEST_UNSET_KEY', models: [] },
          typed: { name: 'Typed', apiKey: '$MORSE_TEST_ACME_KEY', models: [] },
        },
      }),
    );
    mkdirSync(join(botRoot, 'config'), { recursive: true });
    // A provider picked from the global catalog: cloned into the bot without its key.
    const clone = {
      name: 'Acme AI',
      baseUrl: 'https://llm.acme.example/v1',
      apiKey: '',
      models: [{ id: 'acme-chat' }],
    };
    writeFileSync(
      join(botRoot, 'config', 'models.json'),
      JSON.stringify({
        providers: { acme: clone, typed: { name: 'Typed', apiKey: 'bot-typed', models: [] } },
      }),
    );

    expect(importPiGlobalConfig(botRoot)).toBe(true);

    // pi templates auth.json keys the same way, so the copy carries the value.
    expect(readJson(join(botRoot, 'config', 'auth.json'))).toEqual({
      anthropic: { type: 'api_key', key: 'raw-acme' },
    });
    const providers = (
      readJson(join(botRoot, 'config', 'models.json')) as { providers: Record<string, unknown> }
    ).providers;
    // The clone gains the machine's value; an unset name stays a reference; a
    // typed key is never touched.
    expect(providers['acme']).toEqual({ ...clone, apiKey: 'raw-acme' });
    expect(providers['missing']).toEqual({
      name: 'Missing',
      apiKey: '$MORSE_TEST_UNSET_KEY',
      models: [],
    });
    expect(providers['typed']).toEqual({ name: 'Typed', apiKey: 'bot-typed', models: [] });
  });
});
