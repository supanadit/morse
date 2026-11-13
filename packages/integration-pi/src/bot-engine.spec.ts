import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  writePiCredentials,
} from './bot-engine.js';

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
});

describe('PI_INSTALL_HINT', () => {
  it('re-exports the install command the wizard offers', () => {
    expect(PI_INSTALL_HINT).toBe(PI_INSTALL_COMMAND);
  });
});

describe('writePiCredentials', () => {
  it('writes pi auth.json in the bot config dir with mode 0600', () => {
    const botRoot = tempRoot();

    writePiCredentials(botRoot, [{ provider: 'anthropic', apiKey: 'sk' }]);

    const path = join(botRoot, 'config', 'auth.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      anthropic: { type: 'api', key: 'sk' },
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
      anthropic: { type: 'api', key: 'sk-new' },
    });
    expectPrivateFile(path);
    // The atomic write leaves no temp file beside the secret.
    expect(readdirSync(configDir)).toEqual(['auth.json']);
  });
});
