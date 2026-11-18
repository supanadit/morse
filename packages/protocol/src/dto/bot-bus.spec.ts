import { describe, expect, it } from 'vitest';
import {
  BOT_DESCRIPTION_LIMIT,
  type BotBusSendInput,
  type BotBusSendResult,
  type BotDelivery,
  type BotRosterEntry,
  type BotTurnTrace,
} from './bot-bus.js';
import type { BotTranscriptMessage } from '../wire.js';

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

/**
 * A finished turn leaves a record: the steps it took, the asks it handed on and
 * how it ended. The record travels beside the transcript page it belongs to, so
 * a room draws its history from one push.
 */
describe('bot turn records', () => {
  it('keeps a finished turn as a trace', () => {
    const trace: BotTurnTrace = {
      id: 'd1',
      conversationId: 'dm-sigil',
      username: 'sigil',
      name: 'Sigil',
      startedAt: 10,
      endedAt: 48_000,
      status: 'done',
      steps: [{ kind: 'tool', label: 'Reading brief.md', tool: 'read', at: 12, status: 'ok' }],
      handoffs: [],
    };
    expect(trace.steps[0]?.status).toBe('ok');
  });

  it('carries traces on a transcript page', () => {
    const payload: BotTranscriptMessage['payload'] = {
      conversationId: 'dm-sigil',
      entries: [],
      replace: false,
      traces: [],
    };
    expect(payload.traces).toEqual([]);
  });
});
