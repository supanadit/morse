import { describe, expect, it } from 'vitest';
import { BUS_LIMITS, addressedBots, busRefusal } from './bus.js';

/**
 * The bus's two decisions, tested without a store or a lane: who a person's
 * message reaches, and whether a delivery must be refused. Everything here is a
 * value in and a value out, so a routing bug shows up without an engine running.
 */

describe('addressedBots', () => {
  it('addresses the mentioned bots in mention order', () => {
    expect(
      addressedBots({ text: '@loom then @sigil', members: ['sigil', 'loom'], kind: 'group' }),
    ).toEqual([
      { username: 'loom', reason: 'mention' },
      { username: 'sigil', reason: 'mention' },
    ]);
  });

  it('answers every member when nothing is addressed and there is no lead', () => {
    expect(addressedBots({ text: 'hello', members: ['sigil', 'loom'], kind: 'group' })).toEqual([
      { username: 'sigil', reason: 'all' },
      { username: 'loom', reason: 'all' },
    ]);
  });

  it('sends an unaddressed room message to the lead alone', () => {
    expect(
      addressedBots({ text: 'hello', members: ['sigil', 'loom'], lead: 'loom', kind: 'group' }),
    ).toEqual([{ username: 'loom', reason: 'lead' }]);
  });

  it('never routes an unmentioned direct message anywhere but its bot', () => {
    expect(addressedBots({ text: 'hello', members: ['sigil'], kind: 'dm' })).toEqual([
      { username: 'sigil', reason: 'direct' },
    ]);
  });

  it('ignores a mention that names someone who is not a member', () => {
    expect(addressedBots({ text: '@nobody hello', members: ['sigil'], kind: 'group' })).toEqual([
      { username: 'sigil', reason: 'all' },
    ]);
    expect(
      addressedBots({ text: '@nobody @loom hello', members: ['sigil', 'loom'], kind: 'group' }),
    ).toEqual([{ username: 'loom', reason: 'mention' }]);
  });

  it('maps every member when the message broadcasts to everyone', () => {
    expect(
      addressedBots({ text: '@all standup', members: ['sigil', 'loom'], kind: 'group' }),
    ).toEqual([
      { username: 'sigil', reason: 'all' },
      { username: 'loom', reason: 'all' },
    ]);
  });

  it('routes a private thread like a room, never like a DM', () => {
    expect(
      addressedBots({ text: 'hello', members: ['sigil', 'loom'], lead: 'loom', kind: 'thread' }),
    ).toEqual([{ username: 'loom', reason: 'lead' }]);
    expect(addressedBots({ text: 'hello', members: ['sigil', 'loom'], kind: 'thread' })).toEqual([
      { username: 'sigil', reason: 'all' },
      { username: 'loom', reason: 'all' },
    ]);
  });

  it('falls through to everyone when the named lead is not a member', () => {
    expect(
      addressedBots({ text: 'hello', members: ['sigil', 'loom'], lead: 'moss', kind: 'group' }),
    ).toEqual([
      { username: 'sigil', reason: 'all' },
      { username: 'loom', reason: 'all' },
    ]);
  });
});

describe('busRefusal', () => {
  it('refuses a relay past the depth, root, queue and hourly caps', () => {
    expect(busRefusal({ depth: 5, rootCount: 1, queueLength: 0, recentCount: 0 })).toMatch(
      /depth/i,
    );
    expect(busRefusal({ depth: 1, rootCount: 49, queueLength: 0, recentCount: 0 })).toMatch(/48/);
    expect(busRefusal({ depth: 1, rootCount: 1, queueLength: 33, recentCount: 0 })).toMatch(
      /queue/i,
    );
    expect(busRefusal({ depth: 1, rootCount: 1, queueLength: 0, recentCount: 61 })).toMatch(
      /hour/i,
    );
    expect(busRefusal({ depth: 1, rootCount: 1, queueLength: 0, recentCount: 0 })).toBeUndefined();
  });

  it('takes a delivery that sits exactly at every limit', () => {
    expect(
      busRefusal({ depth: 4, rootCount: 48, queueLength: 32, recentCount: 60 }),
    ).toBeUndefined();
  });

  it('publishes the four caps the lane enforces', () => {
    expect(BUS_LIMITS).toEqual({ depth: 4, perRoot: 48, queuePerBot: 32, perBotPerHour: 60 });
  });
});
