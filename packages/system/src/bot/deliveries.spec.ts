import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotDelivery } from '@morse/protocol';
import { BotDeliveryStore, DELIVERY_TTL_MS } from './deliveries.js';

/**
 * A conversation's deliveries are the queue behind its bot lanes: what one lane
 * hands to the next, and what survives a restart. What matters here is that the
 * file is per conversation and plain enough to read back, a crash does not leave
 * work running forever, old finished work is pruned without touching live work,
 * and an id that names a path is refused.
 */
describe('bot delivery store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-deliveries-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function delivery(overrides: Partial<BotDelivery> & Pick<BotDelivery, 'id'>): BotDelivery {
    return {
      id: overrides.id,
      rootId: overrides.id,
      conversationId: 'dm-sigil',
      entryId: 'entry-1',
      from: { type: 'person', id: 'person-1', name: 'Ada' },
      to: 'sigil',
      kind: 'message',
      reason: 'mention',
      depth: 0,
      createdAt: 1,
      status: 'queued',
      ...overrides,
    };
  }

  it('keeps a conversation’s deliveries across a restart, in order', () => {
    const store = new BotDeliveryStore(dir);
    store.add(delivery({ id: 'a', to: 'sigil' }));
    store.add(delivery({ id: 'b', to: 'sigil', createdAt: 2 }));

    expect(new BotDeliveryStore(dir).all('dm-sigil').map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('re-queues a delivery a crash left running', () => {
    const store = new BotDeliveryStore(dir);
    store.add(delivery({ id: 'a', status: 'running' }));

    store.requeueRunning();

    expect(store.all('dm-sigil')[0]?.status).toBe('queued');
  });

  it('prunes only terminal deliveries past the ttl', () => {
    const store = new BotDeliveryStore(dir);
    store.add(delivery({ id: 'old', status: 'done', createdAt: 1 }));
    store.add(delivery({ id: 'live', status: 'queued', createdAt: 1 }));

    store.prune(2 + DELIVERY_TTL_MS, DELIVERY_TTL_MS);

    expect(store.all('dm-sigil').map((row) => row.id)).toEqual(['live']);
  });

  it('refuses a conversation id that is not path-safe', () => {
    expect(() => new BotDeliveryStore(dir).all('../etc')).toThrow(/usable conversation id/);
  });

  it('replaces a row whose id is already stored instead of appending a duplicate', () => {
    const store = new BotDeliveryStore(dir);
    store.add(delivery({ id: 'a' }));
    store.add(delivery({ id: 'b', createdAt: 2 }));
    store.add(delivery({ id: 'a', createdAt: 3, status: 'done' }));

    const rows = store.all('dm-sigil');
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    // The replacement takes the row's place, so file order still tells the story.
    expect(rows[0]).toMatchObject({ id: 'a', createdAt: 3, status: 'done' });
  });

  it('reads a missing file as empty and refuses a malformed one with its path', () => {
    const store = new BotDeliveryStore(dir);
    expect(store.all('dm-sigil')).toEqual([]);

    writeFileSync(join(dir, 'dm-sigil.json'), '{');

    expect(() => store.all('dm-sigil')).toThrow('dm-sigil.json');
  });

  it('never replaces a terminal status and keeps a note when none is passed', () => {
    const store = new BotDeliveryStore(dir);
    store.add(delivery({ id: 'a', status: 'running' }));
    store.setStatus('dm-sigil', 'a', 'done', 'answered');
    store.setStatus('dm-sigil', 'a', 'running');
    store.setStatus('dm-sigil', 'a', 'failed');

    expect(store.all('dm-sigil')[0]).toMatchObject({ status: 'done', note: 'answered' });
  });
});
