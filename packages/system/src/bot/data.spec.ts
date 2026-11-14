import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotEngineConfig, BotEngineState } from './types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../logger.js';
import { CURRENT_DATA_LAYOUT, maintainData, readDataVersion } from '../data/layout.js';
import { botDataMigrations, reconcileBotData, type BotDataContext } from './data.js';
import type { BotEngineAdapter } from './service.js';
import { loadBotRegistry, saveBotRegistry } from './store.js';

/**
 * Bot mode's share of the upgrade contract: an older `engine.json` moves into the
 * engine's own files once, and every start repairs a bot whose engine tree lost
 * its configuration — without ever overwriting what is already there.
 */
describe('bot data maintenance', () => {
  let root: string;
  let botDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morse-bot-data-'));
    botDir = join(root, 'bot');
    mkdirSync(botDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** An engine adapter whose "engine files" are an in-memory map. */
  function fakeAdapter(state: BotEngineState = {}): BotEngineAdapter & {
    writes: BotEngineConfig[];
    current: BotEngineState;
  } {
    const adapter = {
      kind: 'fake',
      capabilities: {
        supportsSubagents: true,
        supportsThinkingLevels: true,
        credentials: 'stored' as const,
      },
      writes: [] as BotEngineConfig[],
      current: state,
      createFactory: () => {
        throw new Error('not used in this test');
      },
      layout: {
        write: (_botRoot: string, config: BotEngineConfig): void => {
          adapter.writes.push(config);
          adapter.current = {
            persona: config.persona,
            ...(config.model === undefined ? {} : { model: config.model }),
            ...(config.agentsMd === undefined ? {} : { agentsMd: config.agentsMd }),
            ...(config.subagents === undefined ? {} : { subagents: config.subagents }),
          };
        },
        read: (): BotEngineState => adapter.current,
      },
    };
    return adapter;
  }

  const legacyBot = {
    username: 'forge',
    name: 'Forge',
    description: 'Builds things',
    engineKind: 'fake',
    credentialEnv: [],
    persona: 'You are Forge.',
    model: { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude' },
    thinkingLevel: 'medium',
    subagents: [{ name: 'reviewer', prompt: 'Read the diff.' }],
  };

  function seedLegacy(): void {
    mkdirSync(join(botDir, 'forge', 'workspace'), { recursive: true });
    writeFileSync(join(botDir, 'forge', 'engine.json'), JSON.stringify(legacyBot));
    saveBotRegistry(botDir, {
      version: 2,
      bots: [legacyBot],
      groups: [],
      conversations: [],
    } as never);
  }

  it('moves a legacy engine.json into the engine own layout, once', () => {
    seedLegacy();
    const adapter = fakeAdapter();

    const result = maintainData({
      root,
      logger: silentLogger,
      migrations: botDataMigrations(),
      extra: { adapters: { fake: adapter } },
    });

    expect(result.to).toBe(readDataVersion(root).layout);
    expect(result.applied).toContain('write each bot configuration into its engine own files');
    // The engine's own files hold the model, persona and subagents now.
    expect(adapter.writes).toHaveLength(1);
    expect(adapter.writes[0]).toMatchObject({
      username: 'forge',
      persona: 'You are Forge.',
      model: legacyBot.model,
      thinkingLevel: 'medium',
      subagents: legacyBot.subagents,
      credentials: [],
    });
    // The record went back to being an index entry.
    const identity = JSON.parse(
      readFileSync(join(botDir, 'forge', 'engine.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(identity).toMatchObject({ username: 'forge', name: 'Forge' });
    expect(identity).not.toHaveProperty('persona');
    expect(identity).not.toHaveProperty('model');
    // And the files it rewrote are backed up first.
    expect(loadBotRegistry(botDir).bots[0]).not.toHaveProperty('persona');
  });

  it('still migrates a legacy record when the read only reports an empty mcpServers', () => {
    seedLegacy();
    // OpenCode's reader always answers with an array, even when opencode.json is
    // missing, so an empty one must not look like an existing configuration.
    const adapter = fakeAdapter({ mcpServers: [] });

    const result = maintainData({
      root,
      logger: silentLogger,
      migrations: botDataMigrations(),
      extra: { adapters: { fake: adapter } },
    });

    expect(result.applied).toContain('write each bot configuration into its engine own files');
    expect(adapter.writes).toHaveLength(1);
    expect(adapter.writes[0]).toMatchObject({
      persona: 'You are Forge.',
      model: legacyBot.model,
    });
  });

  it('still warns about a bot with no engine configuration when the read is an empty mcpServers', () => {
    saveBotRegistry(botDir, {
      version: 2,
      bots: [
        {
          username: 'forge',
          name: 'Forge',
          description: 'Builds things',
          engineKind: 'fake',
          credentialEnv: [],
        },
      ],
      groups: [],
      conversations: [],
    });
    const adapter = fakeAdapter({ mcpServers: [] });
    const warn = vi.fn();

    reconcileBotData({
      root,
      logger: { ...silentLogger, warn },
      now: () => new Date(),
      backup: () => undefined,
      adapters: { fake: adapter },
    });

    expect(adapter.writes).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('set it up from Edit bot'));
  });

  it('asks each engine layout to move files an earlier Morse put in the wrong place', () => {
    seedLegacy();
    const repaired: string[] = [];
    const adapter = {
      ...fakeAdapter(),
      layout: {
        ...fakeAdapter().layout,
        repair: (botRoot: string): void => {
          repaired.push(botRoot);
        },
      },
    };

    const result = maintainData({
      root,
      logger: silentLogger,
      migrations: botDataMigrations(),
      extra: { adapters: { fake: adapter } },
    });

    expect(result.to).toBe(CURRENT_DATA_LAYOUT);
    expect(result.applied).toContain(
      'let each engine move files an earlier Morse put in the wrong place',
    );
    // Once per bot per repair step, with the bot's own root: the engine knows its
    // layout. Two steps call it today (3 and 4), hence the bot twice.
    expect(repaired).toEqual([join(botDir, 'forge'), join(botDir, 'forge')]);
  });

  it("does not let one bot's broken engine config stop the others being repaired", () => {
    seedLegacy();
    saveBotRegistry(botDir, {
      version: 2,
      bots: [
        {
          username: 'forge',
          name: 'Forge',
          description: '',
          engineKind: 'fake',
          credentialEnv: [],
        },
        {
          username: 'sable',
          name: 'Sable',
          description: '',
          engineKind: 'other',
          credentialEnv: [],
        },
      ],
      groups: [],
      conversations: [],
    });
    const warn = vi.fn();
    const broken = {
      ...fakeAdapter(),
      kind: 'fake',
      layout: {
        ...fakeAdapter().layout,
        repair: (): void => {
          throw new Error('config is not JSON');
        },
      },
    };
    const repaired: string[] = [];
    const other = {
      ...fakeAdapter(),
      kind: 'other',
      layout: {
        ...fakeAdapter().layout,
        repair: (botRoot: string): void => {
          repaired.push(botRoot);
        },
      },
    };

    maintainData({
      root,
      logger: { ...silentLogger, warn },
      migrations: botDataMigrations(),
      extra: { adapters: { fake: broken, other } },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not repair'));
    // The second bot was still repaired, once per repair step.
    expect(repaired).toEqual([join(botDir, 'sable'), join(botDir, 'sable')]);
  });

  it('does nothing on the next start', () => {
    seedLegacy();
    const adapters = { fake: fakeAdapter() };
    maintainData({
      root,
      logger: silentLogger,
      migrations: botDataMigrations(),
      extra: { adapters },
    });

    const second = fakeAdapter();
    maintainData({
      root,
      logger: silentLogger,
      migrations: botDataMigrations(),
      extra: { adapters: { fake: second } },
    });

    expect(second.writes).toHaveLength(0);
  });

  it('reports a bot whose engine configuration went missing instead of inventing one', () => {
    saveBotRegistry(botDir, {
      version: 2,
      bots: [
        {
          username: 'forge',
          name: 'Forge',
          description: 'Builds things',
          engineKind: 'fake',
          credentialEnv: [],
        },
      ],
      groups: [],
      conversations: [],
    });
    const adapter = fakeAdapter();
    const warn = vi.fn();

    reconcileBotData({
      root,
      logger: { ...silentLogger, warn },
      now: () => new Date(),
      backup: () => undefined,
      adapters: { fake: adapter },
    });

    // The engine's files *are* the configuration, so a bot whose tree is gone has
    // nothing left to restore: writing an empty one would clear the engine's own
    // settings. The reader is told, and the DM comes back so the row still opens.
    expect(adapter.writes).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('set it up from Edit bot'));
    expect(loadBotRegistry(botDir).conversations.map((one) => one.id)).toEqual(['dm-forge']);
  });

  it('never writes over a configuration it could not read', () => {
    saveBotRegistry(botDir, {
      version: 2,
      bots: [
        {
          username: 'forge',
          name: 'Forge',
          description: '',
          engineKind: 'fake',
          credentialEnv: [],
        },
      ],
      groups: [],
      conversations: [],
    });
    const adapter = {
      ...fakeAdapter(),
      layout: {
        ...fakeAdapter().layout,
        read: (): BotEngineState => {
          throw new Error('opencode.json is not JSON');
        },
      },
    };

    reconcileBotData({
      root,
      logger: silentLogger,
      now: () => new Date(),
      backup: () => undefined,
      adapters: { fake: adapter },
    });

    // A malformed engine config is the reader's file to fix; writing "nothing"
    // over it would be the worst outcome of a repair.
    expect(adapter.writes).toHaveLength(0);
  });

  it('never overwrites an engine configuration that is already there', () => {
    saveBotRegistry(botDir, {
      version: 2,
      bots: [
        {
          username: 'forge',
          name: 'Forge',
          description: '',
          engineKind: 'fake',
          credentialEnv: [],
        },
      ],
      groups: [],
      conversations: [
        {
          id: 'dm-forge',
          kind: 'dm',
          title: 'Forge',
          members: ['forge'],
          chainCap: 8,
          sessions: {},
          updatedAt: 1,
        },
      ],
    });
    const adapter = fakeAdapter({ persona: 'Hand-written persona.' });

    reconcileBotData({
      root,
      logger: silentLogger,
      now: () => new Date(),
      backup: () => undefined,
      adapters: { fake: adapter },
    });

    // A hand-edited engine config is what the reader wants: the reconcile only
    // fills gaps, so nothing is written over it.
    expect(adapter.writes).toHaveLength(0);
  });

  it('reports a bot directory no record claims, and leaves it alone', () => {
    saveBotRegistry(botDir, { version: 2, bots: [], groups: [], conversations: [] });
    mkdirSync(join(botDir, 'orphan', 'workspace'), { recursive: true });
    const warn = vi.fn();

    reconcileBotData({
      root,
      logger: { ...silentLogger, warn },
      now: () => new Date(),
      backup: () => undefined,
      adapters: {},
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('belongs to no bot in the registry'));
    // Still on disk: an orphan may be a bot whose registry write was lost, so it
    // is reported rather than deleted.
    expect(existsSync(join(botDir, 'orphan', 'workspace'))).toBe(true);
  });
});
