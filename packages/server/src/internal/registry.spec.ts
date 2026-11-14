import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '@morse/system';
import type { PiRpcAdapter } from '@morse/integration-pi';
import type { MorseServerConfig } from '../app/config.js';
import { createAgentRouter, createBotService } from './registry.js';

/**
 * The composition root's one rule worth testing: the host registers the engines
 * this machine can actually start, and never leaves a draft without a default.
 * An OpenCode-only machine must report OpenCode alone — that single entry is
 * what makes the composer draw no engine picker at all.
 */
const openCodeMock = vi.hoisted(() => vi.fn());

// Only the host-engine opener is replaced. The bot adapters are the real ones:
// masking them would make this file's module mock a different module than the
// composition root imports.
vi.mock('@morse/integration-opencode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@morse/integration-opencode')>();
  return { ...actual, openOpenCodeEngine: openCodeMock };
});

interface FakeEngine {
  kind: string;
  catalog: unknown;
  extras: unknown;
}

function engine(kind: string): FakeEngine {
  return { kind, catalog: { kind }, extras: { kind } };
}

/** A pi adapter whose binary is either found (`describe` returns) or missing. */
function piAdapter(installed: boolean): PiRpcAdapter {
  return {
    engine: engine('pi'),
    catalog: { kind: 'pi' },
    extras: { kind: 'pi' },
    describe: () => {
      if (!installed) {
        throw new Error('The pi coding agent was not found.');
      }
      return { command: 'pi', args: [], source: 'path' };
    },
  } as unknown as PiRpcAdapter;
}

function openCodeEngine(owned = true) {
  return {
    engine: engine('opencode'),
    catalog: { kind: 'opencode' },
    extras: { kind: 'opencode' },
    owned,
    baseUrl: 'http://127.0.0.1:4096',
  };
}

function config(overrides: Partial<MorseServerConfig> = {}): MorseServerConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    uiDir: '/tmp/ui',
    workspace: { cwd: '/work/morse', name: 'morse' },
    noSession: true,
    requestTimeoutMs: 1000,
    sessionsPerProject: 10,
    hotSessions: 2,
    projects: [],
    uploadDir: '/tmp/uploads',
    dataDir: mkdtempSync(join(tmpdir(), 'morse-registry-')),
    terminalIdleMs: 0,
    updateCheck: false,
    selfUpdate: false,
    ...overrides,
  } as MorseServerConfig;
}

describe('createAgentRouter engine registration', () => {
  it('offers both engines when both resolve, defaulting to pi', async () => {
    openCodeMock.mockResolvedValue(openCodeEngine());
    const router = await createAgentRouter(piAdapter(true), config(), silentLogger);

    expect(router.engineOptions()).toEqual([
      { kind: 'pi', label: 'pi', default: true },
      { kind: 'opencode', label: 'OpenCode' },
    ]);
  });

  it('reports OpenCode alone when pi is not installed', async () => {
    openCodeMock.mockResolvedValue(openCodeEngine());
    const router = await createAgentRouter(piAdapter(false), config(), silentLogger);

    expect(router.engineOptions()).toEqual([
      { kind: 'opencode', label: 'OpenCode', default: true },
    ]);
    expect(router.defaultEngineKind).toBe('opencode');
  });

  it('ignores a preference for an engine this machine cannot run', async () => {
    openCodeMock.mockResolvedValue(openCodeEngine());
    const router = await createAgentRouter(
      piAdapter(false),
      config({ engine: 'pi' }),
      silentLogger,
    );

    expect(router.defaultEngineKind).toBe('opencode');
  });

  it('honours MORSE_ENGINE when both engines resolve', async () => {
    openCodeMock.mockResolvedValue(openCodeEngine());
    const router = await createAgentRouter(
      piAdapter(true),
      config({ engine: 'opencode' }),
      silentLogger,
    );

    expect(router.defaultEngineKind).toBe('opencode');
  });

  it('reports no engine when nothing resolves, so the setup screen names both installs', async () => {
    openCodeMock.mockResolvedValue(undefined);
    const router = await createAgentRouter(piAdapter(false), config(), silentLogger);

    expect(router.engineOptions()).toEqual([]);
    expect(router.defaultEngineKind).toBeUndefined();
  });
});

describe('createBotService containment', () => {
  it('leaves bot mode out of a host whose registry is corrupt, and boots the rest', async () => {
    const cfg = config();
    const botDir = join(cfg.dataDir, 'bot');
    mkdirSync(botDir, { recursive: true });
    // A `null` in `bots` is exactly the shape the old guard let through and that
    // then failed deep inside the first round.
    writeFileSync(
      join(botDir, 'registry.json'),
      JSON.stringify({ version: 1, bots: [null], groups: [], conversations: [] }),
    );
    const errors: string[] = [];
    const logger = { ...silentLogger, error: (message: string) => errors.push(message) };

    expect(createBotService(cfg, logger)).toBeUndefined();
    // Two reports, both true: the upgrade refused to touch a registry it cannot
    // read, and the host then started without bot mode instead of dying.
    expect(errors.some((one) => one.includes('could not prepare its data directory'))).toBe(true);
    expect(errors.some((one) => one.includes('Bot mode is unavailable'))).toBe(true);
    expect(errors.join(' ')).toContain('registry.json');
    // Refusing to migrate must leave the file exactly as it was found.
    expect(readFileSync(join(botDir, 'registry.json'), 'utf8')).toContain('"bots":[null]');

    // The composition root still builds its engines: code sessions do not need
    // the bot roster, and a corrupt one must not take the whole host down.
    openCodeMock.mockResolvedValue(openCodeEngine());
    const router = await createAgentRouter(piAdapter(true), cfg, silentLogger);
    expect(router.engineOptions().map((option) => option.kind)).toEqual(['pi', 'opencode']);
  });

  it('builds the service for a registry that is merely absent', () => {
    const cfg = config();

    expect(createBotService(cfg, silentLogger)).toBeDefined();
  });
});
