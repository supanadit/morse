import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MorseSessionRecord } from './record.js';
import { FileSessionStore } from './file-store.js';

/**
 * The file store is the whole of Morse's session persistence, so what matters
 * here is what a restart sees: a write is on disk before the promise resolves, a
 * reload yields exactly what was written (tokens included), last-wins settles a
 * double write, a removal is gone for good, and an index that has outgrown its
 * records is compacted without losing either a record or a token.
 */
describe('FileSessionStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morse-file-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function record(id: string, title = `Session ${id}`): MorseSessionRecord {
    return {
      version: 2,
      id,
      title,
      cwd: '/work/project',
      engineRef: { engine: 'test', sessionId: `engine-${id}` },
      createdAt: 1_000,
      updatedAt: 2_000,
      messageCount: 2,
    };
  }

  it('round-trips records and tokens through a reload, sharded as one file per record', async () => {
    const store = new FileSessionStore(dir);
    await store.write(record('aa1111'), 't1');
    await store.write(record('bb2222'), 't2');

    const reloaded = new FileSessionStore(dir);
    expect((await reloaded.list()).map((entry) => entry.id).sort()).toEqual(['aa1111', 'bb2222']);
    expect(await reloaded.read('aa1111')).toMatchObject({ title: 'Session aa1111' });
    expect(new Map(await reloaded.tokens()).get('aa1111')).toBe('t1');
    expect(new Map(await reloaded.tokens()).get('bb2222')).toBe('t2');
    expect(existsSync(join(dir, 'records', 'aa', 'aa1111.json'))).toBe(true);
    expect(existsSync(join(dir, 'records', 'bb', 'bb2222.json'))).toBe(true);
  });

  it('settles a double write last-wins, and keeps the token across a tokenless rename', async () => {
    const store = new FileSessionStore(dir);
    await store.write(record('aa1111', 'first'), 't1');
    await store.write(record('aa1111', 'second'));

    const reloaded = new FileSessionStore(dir);
    expect(await reloaded.read('aa1111')).toMatchObject({ title: 'second' });
    // A tokenless write is a Morse-only change; the engine's last token still
    // counts, so reconcile keeps treating the session as unchanged.
    expect(new Map(await reloaded.tokens()).get('aa1111')).toBe('t1');
  });

  it('removes the record from the next load, including its token', async () => {
    const store = new FileSessionStore(dir);
    await store.write(record('aa1111'), 't1');

    await store.remove('aa1111');
    const reloaded = new FileSessionStore(dir);
    expect(await reloaded.read('aa1111')).toBeUndefined();
    expect((await reloaded.list()).map((entry) => entry.id)).toEqual([]);
    expect((await reloaded.tokens()).size).toBe(0);
  });

  it('compacts an oversized index on the next load, keeping records and tokens', async () => {
    const store = new FileSessionStore(dir);
    // One record rewritten a few thousand times grows the append-only index far
    // past twice its record count.
    for (let index = 0; index < 3_000; index += 1) {
      await store.write(record('aa1111', `title ${index}`), `t${index}`);
    }
    const indexFile = join(dir, 'index.jsonl');
    const before = readFileSync(indexFile, 'utf8').split('\n').filter((line) => line.length > 0).length;
    expect(before).toBe(3_000);

    const reloaded = new FileSessionStore(dir);
    const after = readFileSync(indexFile, 'utf8').split('\n').filter((line) => line.length > 0).length;
    expect(after).toBe(1);
    expect(await reloaded.read('aa1111')).toMatchObject({ title: 'title 2999' });
    expect(new Map(await reloaded.tokens()).get('aa1111')).toBe('t2999');
  });

  it('ignores a torn final index line instead of losing the whole index', async () => {
    const store = new FileSessionStore(dir);
    await store.write(record('aa1111'), 't1');
    appendFileSync(join(dir, 'index.jsonl'), '{"token":"half');

    const reloaded = new FileSessionStore(dir);
    expect((await reloaded.list()).map((entry) => entry.id)).toEqual(['aa1111']);
    expect(new Map(await reloaded.tokens()).get('aa1111')).toBe('t1');
  });

  it('reads a first-run directory as an empty store', async () => {
    const store = new FileSessionStore(dir);
    expect(await store.list()).toEqual([]);
    expect((await store.tokens()).size).toBe(0);
  });
});
