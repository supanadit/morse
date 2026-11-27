import { describe, expect, it } from 'vitest';
import { BUS_LIMITS, addressedBots, busRefusal, replyAddressedBots } from './bus.js';

/**
 * The bus's decisions, tested without a store or a lane: who a person's
 * message reaches, who a bot's reply asks, and whether a delivery must be
 * refused. Everything here is a value in and a value out, so a routing bug shows
 * up without an engine running.
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

describe('replyAddressedBots', () => {
  const members = ['sigil', 'loom', 'sage'];

  it('asks the members a reply names, in mention order', () => {
    expect(
      replyAddressedBots({
        text: '@sage and @loom: report in',
        members,
        self: 'sigil',
      }),
    ).toEqual([
      { username: 'sage', reason: 'mention' },
      { username: 'loom', reason: 'mention' },
    ]);
  });

  it('never asks the bot that wrote the reply, or the bot whose ask it answers', () => {
    // Loom answering Sigil's ask: naming Sigil back is the answer, not a new ask.
    expect(
      replyAddressedBots({ text: '@sigil done, @sigil', members, self: 'loom', asker: 'sigil' }),
    ).toEqual([]);
    expect(
      replyAddressedBots({ text: '@loom @sage fyi', members, self: 'loom', asker: 'sigil' }),
    ).toEqual([{ username: 'sage', reason: 'mention' }]);
  });

  it('asks nobody on a broadcast or an unknown handle, and nothing on a plain reply', () => {
    // `@all` is a person's word: a bot must name whom it is talking to.
    expect(
      replyAddressedBots({ text: '@all standup', members, self: 'sigil' }),
    ).toEqual([]);
    expect(
      replyAddressedBots({ text: '@nobody @Forge hi', members, self: 'sigil' }),
    ).toEqual([]);
    expect(replyAddressedBots({ text: 'all good', members, self: 'sigil' })).toEqual([]);
  });
});

describe('busRefusal', () => {
  it('stops a relay past the depth, root and hourly caps', () => {
    expect(busRefusal({ depth: 5, rootCount: 1, recentCount: 0 })).toMatch(/depth/i);
    expect(busRefusal({ depth: 1, rootCount: 49, recentCount: 0 })).toMatch(/48/);
    expect(busRefusal({ depth: 1, rootCount: 1, recentCount: 61 })).toMatch(/hour/i);
    expect(busRefusal({ depth: 1, rootCount: 1, recentCount: 0 })).toBeUndefined();
  });

  it('drops a depth or root overflow rather than calling it a refusal', () => {
    expect(busRefusal({ depth: 5, rootCount: 1, recentCount: 0 })).toMatch(/not queued/i);
    expect(busRefusal({ depth: 1, rootCount: 49, recentCount: 0 })).toMatch(/not queued/i);
    expect(busRefusal({ depth: 1, rootCount: 1, recentCount: 61 })).toMatch(/refused/i);
  });

  it('does not take a queue length: a full queue drops the oldest, never the newcomer', () => {
    // The queue cap is the lane's, so a queue-like field must not become an arm
    // here by accident; this call is the one the lane actually makes.
    expect(busRefusal({ depth: 1, rootCount: 1, recentCount: 0 })).toBeUndefined();
    const ignoringExtraFields = busRefusal as (input: unknown) => string | undefined;
    expect(
      ignoringExtraFields({ depth: 1, rootCount: 1, recentCount: 0, queueLength: 33 }),
    ).toBeUndefined();
  });

  it('takes a delivery that sits exactly at every limit', () => {
    expect(busRefusal({ depth: 4, rootCount: 48, recentCount: 60 })).toBeUndefined();
  });

  it('publishes the four caps the lane enforces', () => {
    expect(BUS_LIMITS).toEqual({ depth: 4, perRoot: 48, queuePerBot: 32, perBotPerHour: 60 });
  });
});
