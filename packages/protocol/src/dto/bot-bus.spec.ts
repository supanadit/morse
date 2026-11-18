import { describe, expect, it } from 'vitest';
import {
  BOT_DESCRIPTION_LIMIT,
  type BotBusSendInput,
  type BotBusSendResult,
  type BotDelivery,
  type BotRosterEntry,
} from './bot-bus.js';

/**
 * These shapes are the contract between the host's delivery bus and the plugin
 * tools a bot calls. Nothing runs them yet; the annotations below are what keeps
 * a later task from quietly changing a field a tool already promises.
 */
describe('bot bus shapes', () => {
  it('caps a listed description so a roster stays affordable', () => {
    expect(BOT_DESCRIPTION_LIMIT).toBe(300);
  });

  it('accepts a delivery whose sender is a bot', () => {
    const delivery: BotDelivery = {
      id: 'd1',
      rootId: 'd1',
      conversationId: 'dm-sigil',
      entryId: 'e1',
      from: { type: 'bot', username: 'loom' },
      to: 'sigil',
      kind: 'assign',
      reason: 'bot',
      depth: 1,
      createdAt: 1,
      status: 'queued',
    };
    expect(delivery.status).toBe('queued');
  });

  it('accepts an idle roster entry', () => {
    const entry: BotRosterEntry = {
      username: 'sigil',
      name: 'Sigil',
      description: 'Crafts bot names',
      state: 'idle',
      queued: 0,
      inRoom: true,
    };
    expect(entry.state).toBe('idle');
  });

  it('accepts a bus call and the receipt it answers with', () => {
    const input: BotBusSendInput = { to: 'sigil', text: 'Name this bot' };
    const result: BotBusSendResult = {
      deliveryId: 'd1',
      conversationId: 'dm-sigil',
      queued: true,
    };
    expect(input.kind).toBeUndefined();
    expect(result.queued).toBe(true);
  });
});
