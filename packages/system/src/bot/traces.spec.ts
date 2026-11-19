import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotTurnTrace } from '@morse/protocol';
import { BotTraceStore, TRACE_LIMIT, TRACE_TTL_MS } from './traces.js';

/**
 * A room's finished turns are history, not context: each one is written once a
 * turn settles, read beside the transcript page it belongs to, and never handed
 * to an engine. What matters here is that the file is per conversation, a
 * repeated turn replaces itself, history ages out and stays bounded, and an id
 * that names a path is refused.
 */
describe('bot trace store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-traces-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function trace(overrides: Partial<BotTurnTrace> & Pick<BotTurnTrace, 'id'>): BotTurnTrace {
    return {
      id: overrides.id,
      conversationId: 'dm-sigil',
      username: 'sigil',
      name: 'Sigil',
      startedAt: 0,
      endedAt: 0,
      status: 'done',
      steps: [],
      handoffs: [],
      ...overrides,
    };
  }

  it('keeps a conversation’s turns newest last and replaces a repeated id', () => {
    const store = new BotTraceStore(dir);
    store.add(trace({ id: 'a', endedAt: 1 }));
    store.add(trace({ id: 'b', endedAt: 2 }));
    store.add(trace({ id: 'b', endedAt: 3 }));

    expect(store.all('dm-sigil').map((row) => row.endedAt)).toEqual([1, 3]);
  });

  it('drops what is old and keeps the newest hundred', () => {
    const store = new BotTraceStore(dir);
    const now = 10_000_000;
    for (let index = 0; index < 120; index += 1) {
      store.add(trace({ id: `turn-${index}`, endedAt: now - 1_000 + index }));
    }
    // One turn past the TTL and one exactly on the cutoff, which is still kept.
    store.add({
      ...trace({ id: 'stale', endedAt: now - TRACE_TTL_MS - 1 }),
      conversationId: 'dm-loom',
    });
    store.add({ ...trace({ id: 'edge', endedAt: now - TRACE_TTL_MS }), conversationId: 'dm-loom' });

    store.prune(now);

    const kept = store.all('dm-sigil');
    expect(kept).toHaveLength(TRACE_LIMIT);
    expect(kept[0]?.id).toBe('turn-20');
    expect(kept.at(-1)?.id).toBe('turn-119');
    expect(store.all('dm-loom').map((row) => row.id)).toEqual(['edge']);
  });

  it('refuses an id that is not path-safe', () => {
    expect(() => new BotTraceStore(dir).all('../etc')).toThrow(/usable conversation id/);
  });

  it('throws naming the file when one is malformed', () => {
    const store = new BotTraceStore(dir);
    writeFileSync(join(dir, 'dm-sigil.json'), '{"nope":');

    expect(() => store.all('dm-sigil')).toThrow(/dm-sigil\.json/);
  });

  it('refuses a trace whose reply cannot be drawn', () => {
    const store = new BotTraceStore(dir);
    // Half a reply — a reader would print its time and its words, and both are
    // missing — so the file is refused rather than drawn broken.
    writeFileSync(
      join(dir, 'dm-sigil.json'),
      `${JSON.stringify([{ ...trace({ id: 'b' }), reply: { username: 'loom' } }])}\n`,
    );

    expect(() => store.all('dm-sigil')).toThrow(/dm-sigil\.json/);
  });

  it('leaves every other room readable when one file is bad', () => {
    const store = new BotTraceStore(dir);
    store.add({ ...trace({ id: 'a', endedAt: 1 }), conversationId: 'dm-loom' });
    writeFileSync(join(dir, 'dm-sigil.json'), '{"nope":');

    expect(() => store.all('dm-sigil')).toThrow();
    expect(store.all('dm-loom')).toHaveLength(1);
  });

  it('prunes the healthy rooms when one file is unreadable, naming it', () => {
    const store = new BotTraceStore(dir);
    store.add(trace({ id: 'old', endedAt: 1 }));
    writeFileSync(join(dir, 'dm-broken.json'), '{');

    expect(() => store.prune(TRACE_TTL_MS + 100)).toThrow(/dm-broken\.json/);

    // The broken file did not stop the sweep: the healthy room was pruned.
    expect(store.all('dm-sigil')).toEqual([]);
  });

  it('forgets a room and tolerates one that has no file', () => {
    const store = new BotTraceStore(dir);
    store.add(trace({ id: 'a', endedAt: 1 }));

    store.forget('dm-sigil');
    store.forget('dm-sigil');

    expect(store.all('dm-sigil')).toEqual([]);
  });
});
