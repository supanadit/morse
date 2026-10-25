import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo } from '@morse/agent';
import type { MorseSessionRecord } from './record.js';
import type { SessionStore } from './ports.js';
import { reconcileSessions } from './reconcile.js';

/**
 * Reconcile merges a harness report into Morse's index. What matters here is the
 * token round-trip: the token a report carries is written *beside* the record
 * through the store, the next reconcile reads it back from the store rather than
 * from caller-held state, and a report that still carries the same token writes
 * nothing — that skip is what makes reconcile cheap on the common path.
 */

/** In-store record map plus a token map: good enough to test the token routing. */
class MemoryStore implements SessionStore {
  readonly records = new Map<string, MorseSessionRecord>();
  readonly lastWriteTokens = new Map<string, string | undefined>();
  /** Simulates a store whose tokens survive restarts (the file store's index). */
  readonly persistedTokens = new Map<string, string>();

  async list(): Promise<MorseSessionRecord[]> {
    return [...this.records.values()];
  }

  async read(id: string): Promise<MorseSessionRecord | undefined> {
    return this.records.get(id);
  }

  async write(record: MorseSessionRecord, token?: string): Promise<void> {
    this.records.set(record.id, record);
    this.lastWriteTokens.set(record.id, token);
    if (token !== undefined) {
      this.persistedTokens.set(record.id, token);
    }
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
    this.persistedTokens.delete(id);
  }

  async tokens(): Promise<ReadonlyMap<string, string>> {
    return this.persistedTokens;
  }
}

function info(overrides: Partial<AgentSessionInfo>): AgentSessionInfo {
  return {
    sessionId: 'engine-1',
    cwd: '/work/project',
    updatedAt: 1_000,
    messageCount: 2,
    token: 'mtime:100:size:10',
    ...overrides,
  };
}

describe('reconcileSessions', () => {
  it('writes each reported session with its token, and re-runs leave the index alone', async () => {
    const store = new MemoryStore();
    const scan = (): Promise<AgentSessionInfo[]> =>
      Promise.resolve([
        info({ sessionId: 'engine-1', token: 't1' }),
        info({ sessionId: 'engine-2', token: 't2' }),
      ]);

    const first = await reconcileSessions({ kind: 'test', scan, store });
    expect(first.upserts).toHaveLength(2);
    expect(first.removals).toEqual([]);
    expect(store.lastWriteTokens.get(first.upserts[0]?.id)).toBe('t1');
    expect(store.lastWriteTokens.get(first.upserts[1]?.id)).toBe('t2');
    expect(store.persistedTokens.size).toBe(2);

    // Second run, same report: every token matches the store's, so no writes at
    // all — the skip the store-borne tokens exist to enable.
    const second = await reconcileSessions({ kind: 'test', scan, store });
    expect(second.upserts).toEqual([]);
    expect(second.removals).toEqual([]);
    expect(second.reported).toBe(2);
    expect(store.records.size).toBe(2);
  });

  it('updates a session whose token changed and keeps the others untouched', async () => {
    const store = new MemoryStore();
    let tokens = 't1';
    await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve([info({ sessionId: 'engine-1', token: tokens })]),
      store,
    });

    tokens = 't2';
    const second = await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve([info({ sessionId: 'engine-1', token: tokens })]),
      store,
    });
    expect(second.upserts).toHaveLength(1);
    expect(store.lastWriteTokens.get(second.upserts[0]?.id)).toBe('t2');
    expect(store.persistedTokens.get(second.upserts[0]?.id)).toBe('t2');
  });

  it('falls back to caller-held tokens when the store cannot report its own', async () => {
    // A port-store with no `tokens()`: reconcile then has to trust the caller's
    // map, exactly as it did before mirrored tokens existed.
    const raw = new Map<string, MorseSessionRecord>();
    const writtenTokens = new Map<string, string | undefined>();
    const store: SessionStore = {
      list: () => Promise.resolve([...raw.values()]),
      read: (id: string) => Promise.resolve(raw.get(id)),
      write: (record: MorseSessionRecord, token?: string) => {
        raw.set(record.id, record);
        writtenTokens.set(record.id, token);
        return Promise.resolve();
      },
    };
    const scan = (): Promise<AgentSessionInfo[]> =>
      Promise.resolve([info({ sessionId: 'engine-1', token: 'same' })]);

    // Old tokens say the session changed, so it is written; the write carries
    // the report token even though nobody can read it back from this store.
    await reconcileSessions({ kind: 'test', scan, store, tokens: new Map() });
    expect(writtenTokens.get([...raw.keys()][0] ?? '')).toBe('same');
    expect([...raw.keys()]).toHaveLength(1);

    // The caller's map — not a store — is now the source of "unchanged".
    const morseId = [...raw.keys()][0] ?? '';
    const again = await reconcileSessions({
      kind: 'test',
      scan,
      store,
      tokens: new Map([[morseId, 'same']]),
    });
    expect(again.upserts).toEqual([]);
    expect([...raw.keys()]).toHaveLength(1);
  });

  it('removes the reporting engine\'s absent sessions and never another engine\'s', async () => {
    const store = new MemoryStore();
    await reconcileSessions({
      kind: 'test',
      scan: () =>
        Promise.resolve([info({ sessionId: 'engine-1', token: 't1' }), info({ sessionId: 'engine-2', token: 't2' })]),
      store,
    });
    await reconcileSessions({
      kind: 'other',
      scan: () => Promise.resolve([info({ sessionId: 'other-1', token: 'o1' })]),
      store,
    });

    const result = await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve([info({ sessionId: 'engine-2', token: 't2' })]),
      store,
    });
    expect(result.removals).toHaveLength(1);
    expect(store.persistedTokens.has(result.removals[0] ?? '')).toBe(false);
    // The other engine's row is untouched: a report only speaks for its own.
    expect(store.records.size).toBe(2);
  });
});
