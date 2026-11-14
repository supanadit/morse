import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    username: 'forge',
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
      version: 2,
      bots: [bot],
      groups: [
        {
          id: 'grp-launch-a1b2',
          name: 'Launch',
          members: ['forge', 'sable'],
          lead: 'forge',
          chainCap: 8,
        },
      ],
      conversations: [
        {
          id: 'dm-forge',
          kind: 'dm',
          title: 'Forge',
          members: ['forge'],
          chainCap: 8,
          sessions: { forge: { engineSessionId: 'sess-1' } },
          updatedAt: 1_700_000_000_000,
        },
        {
          id: 'grp-launch-a1b2',
          kind: 'group',
          title: 'Launch',
          members: ['forge', 'sable'],
          lead: 'forge',
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

  it('migrates a version 1 registry: usernames, directories and DMs move with it', () => {
    // Version 1 had one field doing three jobs: a bot's name was its label, its
    // directory and its @mention. Version 2 keeps the label and derives the rest.
    const v1 = {
      version: 1,
      bots: [
        { name: 'Forge', description: 'Builds things', engineKind: 'pi', persona: '', credentialEnv: [] },
        {
          name: 'News Finder',
          description: 'Finds news',
          engineKind: 'pi',
          persona: '',
          credentialEnv: [],
        },
      ],
      groups: [
        {
          id: 'grp-launch-a1b2',
          name: 'Launch',
          members: ['Forge', 'News Finder'],
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
          updatedAt: 1,
        },
        {
          id: 'grp-launch-a1b2',
          kind: 'group',
          title: 'Launch',
          members: ['Forge', 'News Finder'],
          lead: 'Forge',
          chainCap: 8,
          sessions: {},
          updatedAt: 2,
        },
      ],
    };
    writeFileSync(join(dir, 'registry.json'), JSON.stringify(v1));
    mkdirSync(join(dir, 'Forge', 'workspace'), { recursive: true });
    mkdirSync(join(dir, 'News Finder', 'workspace'), { recursive: true });

    const migrated = loadBotRegistry(dir);

    expect(migrated.version).toBe(2);
    // The free-text name survives as the label; the username is derived (sluggish,
    // lowercase, spaces gone) and becomes the identity.
    expect(migrated.bots.map((one) => one.name)).toEqual(['Forge', 'News Finder']);
    expect(migrated.bots.map((one) => one.username)).toEqual(['forge', 'news-finder']);
    expect(migrated.groups[0]?.members).toEqual(['forge', 'news-finder']);
    expect(migrated.groups[0]?.lead).toBe('forge');
    expect(migrated.conversations[0]?.id).toBe('dm-forge');
    expect(migrated.conversations[0]?.title).toBe('Forge');
    expect(migrated.conversations[0]?.sessions).toEqual({ forge: { engineSessionId: 'sess-1' } });
    expect(migrated.conversations[1]?.members).toEqual(['forge', 'news-finder']);
    // The directories moved with the usernames, and the file was saved back as v2.
    expect(existsSync(join(dir, 'forge'))).toBe(true);
    expect(existsSync(join(dir, 'news-finder'))).toBe(true);
    expect(existsSync(join(dir, 'News Finder'))).toBe(false);
    const saved = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')) as { version: number };
    expect(saved.version).toBe(2);
  });

  it('reads a missing registry as an empty v2 registry', () => {
    expect(loadBotRegistry(dir)).toEqual({ version: 2, bots: [], groups: [], conversations: [] });
  });

  it('reports an unreadable-but-present registry instead of treating it as missing', () => {
    // A directory named registry.json fails the read with EISDIR, not ENOENT.
    mkdirSync(join(dir, 'registry.json'));

    expect(() => loadBotRegistry(dir)).toThrow(/EISDIR/);
  });

  it('throws on a malformed registry instead of reading it as empty', () => {
    writeFileSync(join(dir, 'registry.json'), '{');

    expect(() => loadBotRegistry(dir)).toThrow('registry.json');
  });

  it('throws on a registry that is not the expected v1 shape', () => {
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 2 }));

    expect(() => loadBotRegistry(dir)).toThrow('registry.json');
    expect(() => loadBotRegistry(dir)).toThrow('version 1');
  });

  it('rejects an element that is not a record, with the file path', () => {
    // A `null` in an array passed the old top-level check and then failed deep
    // inside a round; the file is refused at load, where the path can be named.
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({ version: 1, bots: [null], groups: [], conversations: [] }),
    );

    expect(() => loadBotRegistry(dir)).toThrow('registry.json');
    expect(() => loadBotRegistry(dir)).toThrow('version 1');
  });

  it('rejects a bot without a name and engine kind, a group without id/name/members, and a bad conversation', () => {
    const cases = [
      { version: 1, bots: [{ name: 'Forge' }], groups: [], conversations: [] },
      {
        version: 1,
        bots: [],
        groups: [{ id: 'grp-1', name: 'Launch', members: 'Forge' }],
        conversations: [],
      },
      {
        version: 1,
        bots: [],
        groups: [],
        conversations: [{ id: 'dm-Forge', kind: 7 }],
      },
    ];

    for (const registry of cases) {
      writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry));
      expect(() => loadBotRegistry(dir)).toThrow('registry.json');
    }
  });

  it('replaces the registry and leaves no temp file behind', () => {
    saveBotRegistry(dir, registry());
    saveBotRegistry(dir, { version: 1, bots: [], groups: [], conversations: [] });

    expect(loadBotRegistry(dir)).toEqual({ version: 2, bots: [], groups: [], conversations: [] });
    expect(readdirSync(dir)).toEqual(['registry.json']);
  });

  it('round-trips a bot identity through engine.json', () => {
    const botRoot = join(dir, 'Forge');
    // Task 5 creates the bot directory; the store only owns the JSON file.
    mkdirSync(botRoot);

    writeBotIdentity(botRoot, bot);

    expect(readBotIdentity(botRoot)).toEqual(bot);
    expect(readFileSync(join(botRoot, 'engine.json'), 'utf8')).toBe(JSON.stringify(bot));
  });

  it('round-trips a bot subagent list through engine.json', () => {
    const botRoot = join(dir, 'Forge');
    mkdirSync(botRoot);
    // The rows are the bot's own answer to "how do I review a diff"; they live
    // beside its identity so copying the bot directory carries them too.
    const withSubagents: BotRecord = {
      ...bot,
      subagents: [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }],
    };

    writeBotIdentity(botRoot, withSubagents);

    expect(readBotIdentity(botRoot)?.subagents).toEqual(withSubagents.subagents);
  });

  it('reads a bot with no subagents as having none', () => {
    const botRoot = join(dir, 'Forge');
    mkdirSync(botRoot);
    writeBotIdentity(botRoot, bot);

    expect(readBotIdentity(botRoot)).not.toHaveProperty('subagents');
  });

  it('reads a bot without engine.json as undefined', () => {
    expect(readBotIdentity(join(dir, 'Missing'))).toBeUndefined();
  });

  it('throws on a malformed engine.json instead of treating it as absent', () => {
    const botRoot = join(dir, 'Forge');
    mkdirSync(botRoot);
    writeFileSync(join(botRoot, 'engine.json'), '{');

    expect(() => readBotIdentity(botRoot)).toThrow('engine.json');
  });

  it('throws on an engine.json without a name and engine kind', () => {
    const botRoot = join(dir, 'Forge');
    mkdirSync(botRoot);
    writeFileSync(join(botRoot, 'engine.json'), JSON.stringify({ name: 'Forge' }));

    expect(() => readBotIdentity(botRoot)).toThrow('engine.json');
  });

  it('names a direct conversation after its bot', () => {
    expect(dmConversationId('Forge')).toBe('dm-Forge');
  });

  it('builds a group id from the slugged name and four random hex digits', () => {
    expect(newGroupId('Launch')).toMatch(/^grp-launch-[0-9a-f]{4}$/);
  });
});
