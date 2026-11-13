import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dmConversationId,
  loadBotRegistry,
  newGroupId,
  readBotIdentity,
  saveBotRegistry,
  writeBotIdentity,
} from './store.js';
import type { BotRecord, BotRegistryFile } from './types.js';

/**
 * The bot registry is the index Morse keeps of its bots, groups and
 * conversations, and `engine.json` is the identity that travels with a bot's
 * directory. What matters here is that a save survives a load intact, a missing
 * file reads back as an empty registry instead of an error, and the generated
 * conversation ids have the shapes the rest of bot mode expects.
 */
describe('bot store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-bot-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const bot: BotRecord = {
    name: 'Forge',
    description: 'Builds things',
    avatar: 'anvil.png',
    engineKind: 'pi',
    model: {
      provider: 'anthropic',
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200_000,
    },
    thinkingLevel: 'medium',
    persona: 'You are Forge, the builder.',
    credentialEnv: ['ANTHROPIC_API_KEY'],
  };

  function registry(): BotRegistryFile {
    return {
      version: 1,
      bots: [bot],
      groups: [
        {
          id: 'grp-launch-a1b2',
          name: 'Launch',
          members: ['Forge', 'Sable'],
          lead: 'Forge',
          chainCap: 8,
        },
      ],
      conversations: [
        {
          id: 'dm-Forge',
          kind: 'dm',
          title: 'Forge',
          members: ['Forge'],
          chainCap: 8,
          sessions: { Forge: { engineSessionId: 'sess-1' } },
          updatedAt: 1_700_000_000_000,
        },
        {
          id: 'grp-launch-a1b2',
          kind: 'group',
          title: 'Launch',
          members: ['Forge', 'Sable'],
          lead: 'Forge',
          chainCap: 8,
          sessions: {},
          updatedAt: 1_700_000_000_001,
        },
      ],
    };
  }

  it('round-trips bots, groups and conversations through registry.json', () => {
    const saved = registry();

    saveBotRegistry(dir, saved);

    expect(loadBotRegistry(dir)).toEqual(saved);
    // The file is plain JSON, not an envelope: later readers and hand edits
    // see exactly the registry the service saved.
    expect(readFileSync(join(dir, 'registry.json'), 'utf8')).toBe(JSON.stringify(saved));
  });

  it('reads a missing registry as an empty v1 registry', () => {
    expect(loadBotRegistry(dir)).toEqual({ version: 1, bots: [], groups: [], conversations: [] });
  });

  it('overwrites the previous registry atomically, leaving no temp file behind', () => {
    saveBotRegistry(dir, registry());
    saveBotRegistry(dir, { version: 1, bots: [], groups: [], conversations: [] });

    expect(loadBotRegistry(dir)).toEqual({ version: 1, bots: [], groups: [], conversations: [] });
    expect(readdirSync(dir)).toEqual(['registry.json']);
  });

  it('round-trips a bot identity through engine.json', () => {
    const botRoot = join(dir, 'Forge');

    writeBotIdentity(botRoot, bot);

    expect(readBotIdentity(botRoot)).toEqual(bot);
    expect(readFileSync(join(botRoot, 'engine.json'), 'utf8')).toBe(JSON.stringify(bot));
  });

  it('reads a bot without engine.json as undefined', () => {
    expect(readBotIdentity(join(dir, 'Missing'))).toBeUndefined();
  });

  it('names a direct conversation after its bot', () => {
    expect(dmConversationId('Forge')).toBe('dm-Forge');
  });

  it('builds a group id from the slugged name and four random hex digits', () => {
    expect(newGroupId('Launch')).toMatch(/^grp-launch-[0-9a-f]{4}$/);
  });
});
