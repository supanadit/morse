import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo } from '@morse/agent';
import { toSessionRecord, type MorseSessionRecord } from './record.js';
import type { SessionStore } from './ports.js';
import { planReconcile, reconcileSessions } from './reconcile.js';

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

  it('adopts nothing unknown when adoptUnknown is false, but updates and prunes owned rows', async () => {
    const store = new MemoryStore();
    const report = [
      info({ sessionId: 'engine-1', token: 't1' }),
      info({ sessionId: 'engine-2', token: 't2' }),
    ];
    // Unknown engine sessions stay out of a user-scoped index.
    const skipped = await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve(report),
      store,
      adoptUnknown: false,
    });
    expect(skipped.upserts).toEqual([]);
    expect(store.records.size).toBe(0);

    // A row the user owns (opened through Morse) still updates on new tokens…
    const owned = toSessionRecord('test', report[0]!);
    await store.write(owned, 't0');
    const updated = await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve(report),
      store,
      adoptUnknown: false,
    });
    expect(updated.upserts.map((record) => record.id)).toEqual([owned.id]);
    // …and is pruned when the engine no longer reports it.
    const pruned = await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve([report[1]!]),
      store,
      adoptUnknown: false,
    });
    expect(pruned.removals).toEqual([owned.id]);
    expect(store.records.size).toBe(0);
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

  it('migrates a stored record from an older shape even when its token is unchanged', async () => {
    const store = new MemoryStore();
    const report = info({ sessionId: 'engine-1', parentSessionId: 'engine-0', subagent: true });
    // What a Morse before the shape wrote: the same session, the same token,
    // but a record without the fields the new shape derives.
    const stale = toSessionRecord('test', report);
    await store.write({ ...stale, version: 1 });
    expect(store.records.get(stale.id)?.version).toBe(1);

    const first = await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve([report]),
      store,
    });
    expect(first.upserts).toHaveLength(1);
    const migrated = store.records.get(stale.id);
    expect(migrated?.version).toBe(2);
    expect(migrated?.parentId).toBeDefined();
    expect(migrated?.subagent).toBe(true);

    // The migration settles: once stored at the current shape, the token skip
    // applies again and the same report writes nothing.
    const second = await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve([report]),
      store,
    });
    expect(second.upserts).toEqual([]);
  });

  it('keeps a subagent marked when a later engine report drops its parent', async () => {
    const store = new MemoryStore();
    await reconcileSessions({
      kind: 'test',
      scan: () =>
        Promise.resolve([
          info({
            sessionId: 'engine-1',
            parentSessionId: 'engine-0',
            subagent: true,
            token: 't1',
          }),
        ]),
      store,
    });
    // A later token arrives with no parent and no subagent mark: the engine
    // forgot its side of the link, but a spawned child stays a child.
    await reconcileSessions({
      kind: 'test',
      scan: () => Promise.resolve([info({ sessionId: 'engine-1', token: 't2' })]),
      store,
    });
    const record = [...store.records.values()][0];
    expect(record?.subagent).toBe(true);
    expect(record?.parentId).toBeDefined();
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

/**
 * A session's title is Morse's once the reader renames it. The engine keeps
 * reporting its own name (a new token on every exchange), and none of those
 * reports may put the engine's words back on the reader's row.
 */
describe('planReconcile pinned titles', () => {
  const reported = (title: string): AgentSessionInfo =>
    info({ title, token: 't2' });

  it('keeps a renamed session’s title when the engine reports a new token', () => {
    const stored: MorseSessionRecord = {
      ...toSessionRecord('test', info({ title: 'Engine name', token: 't1' })),
      title: 'Release prep',
      titlePinned: true,
    };
    const plan = planReconcile(
      'test',
      [reported('Reply with exactly: pi-host')],
      [stored],
      new Map([[stored.id, 't1']]),
    );

    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({ title: 'Release prep', titlePinned: true });
  });

  it('takes the engine’s title for a session the reader never renamed', () => {
    const stored = toSessionRecord('test', info({ title: 'Engine name', token: 't1' }));
    const plan = planReconcile(
      'test',
      [reported('Reply with exactly: pi-host')],
      [stored],
      new Map([[stored.id, 't1']]),
    );

    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]?.title).toBe('Reply with exactly: pi-host');
    expect(plan.upserts[0]).not.toHaveProperty('titlePinned');
  });
});
