import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { ScopedBotPort } from './scoped.js';
import { BotService } from './service.js';
import { saveBotRegistry } from './store.js';
import type { BotRegistryFile } from './types.js';

/**
 * Per-user bots, Slack-style: definitions stay global, every conversation
 * belongs to the login user who opened it. `dm-<bot>` resolves to the caller's
 * own room; nobody else's room is visible or touchable through the lens.
 */
describe('ScopedBotPort', () => {
  let root: string;
  let service: BotService;

  const seed = (conversations: BotRegistryFile['conversations'] = []): void => {
    saveBotRegistry(root, {
      version: 3,
      bots: [
        {
          username: 'nana',
          name: 'Nana',
          description: 'helper',
          engineKind: 'fake',
          credentialEnv: [],
          env: {},
          credentials: {},
          providers: [],
          skills: [],
          mcps: [],
          subagents: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      groups: [],
      conversations,
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morse-scoped-bot-'));
    seed();
    service = new BotService({
      root,
      adapters: {},
      defaultWorkspace: { cwd: root, name: 'morse' },
      logger: silentLogger,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('opens a DM alias into a per-owner room, invisible to anyone else', () => {
    const adit = new ScopedBotPort(service, 'u-adit');
    const bob = new ScopedBotPort(service, 'u-bob');

    // Before anyone opens it, neither sidebar lists a room.
    expect(adit.roster().conversations).toEqual([]);
    expect(bob.roster().conversations).toEqual([]);

    // Opening `dm-nana` creates Adit's own room (stable storage id).
    adit.open('dm-nana');
    const mine = adit.roster().conversations;
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe('dm-nana');
    expect(mine[0]?.title).toBe('Nana');

    // Bob still sees nothing; his open creates his own room.
    expect(bob.roster().conversations).toEqual([]);
    bob.open('dm-nana');
    expect(bob.roster().conversations.map((c) => c.id)).toEqual(['dm-nana']);
    expect(service.ownerOf('dm__u-adit__nana')).toBe('u-adit');
    expect(service.ownerOf('dm__u-bob__nana')).toBe('u-bob');
  });

  it('refuses foreign rooms on every conversation command', () => {
    const adit = new ScopedBotPort(service, 'u-adit');
    const bob = new ScopedBotPort(service, 'u-bob');
    adit.open('dm-nana');
    const foreign = 'dm__u-adit__nana';

    expect(() => bob.open(foreign)).toThrow(/another user/);
    expect(() => bob.history(foreign, undefined)).toThrow(/another user/);
    expect(() => bob.newDiscussion(foreign)).toThrow(/another user/);
    expect(() => bob.routing(foreign)).toThrow(/another user/);
    expect(() => bob.usages(foreign)).toThrow(/another user/);
    // ... and the roster never lists it.
    expect(bob.roster().conversations.map((c) => c.id)).not.toContain(foreign);
  });

  it('maps pushed storage ids back to the alias the UI opened', () => {
    const adit = new ScopedBotPort(service, 'u-adit');
    expect(adit.displayId('dm__u-adit__nana')).toBe('dm-nana');
    expect(adit.displayId('grp-abc')).toBe('grp-abc');
    expect(new ScopedBotPort(service, undefined).displayId('dm__u-adit__nana')).toBe(
      'dm__u-adit__nana',
    );
  });

  it('unscoped mode keeps the legacy shared room', () => {
    // The service reads the registry once at construction, so the legacy
    // room is seeded first.
    seed([
      {
        id: 'dm-nana',
        kind: 'dm',
        title: 'Nana',
        members: ['nana'],
        sessions: {},
        updatedAt: 1,
      },
    ]);
    const legacy = new BotService({
      root,
      adapters: {},
      defaultWorkspace: { cwd: root, name: 'morse' },
      logger: silentLogger,
    });
    const direct = new ScopedBotPort(legacy, undefined);
    direct.open('dm-nana');
    expect(direct.roster().conversations.map((c) => c.id)).toEqual(['dm-nana']);
  });

  it('deleting the bot removes every owner’s DM rooms', () => {
    const adit = new ScopedBotPort(service, 'u-adit');
    const bob = new ScopedBotPort(service, 'u-bob');
    adit.open('dm-nana');
    bob.open('dm-nana');
    expect(service.roster().conversations).toHaveLength(2);
    return service.deleteBot('nana').then(() => {
      expect(service.roster().conversations).toEqual([]);
    });
  });
});
