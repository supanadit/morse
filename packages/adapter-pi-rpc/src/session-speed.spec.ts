import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIN_SPEED_OUTPUT_TOKENS,
  emptySpeed,
  loadSpeed,
  recordSpeed,
  saveSpeed,
  snapshotSpeed,
  speedFile,
  type StoredSessionSpeed,
} from './session-speed.js';

/**
 * pi reports token counts but keeps no clock, so the adapter measures speed
 * itself and persists it per session. These lock the measurement policy (what
 * counts, what the three figures mean) and the file's contract: a resumed
 * session continues, anything unreadable starts fresh.
 */

const SESSION = '/home/reader/.pi/agent/projects/x/s.jsonl';
const OTHER = '/home/reader/.pi/agent/projects/x/other.jsonl';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'morse-speed-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('recordSpeed', () => {
  it('folds a measured message into tokens, seconds and the extremes', () => {
    const first = recordSpeed(emptySpeed(SESSION), 100, 2_000)!;
    expect(first.messages).toBe(1);
    expect(first.tokens).toBe(100);
    expect(first.seconds).toBe(2);
    expect(first.peak).toBeCloseTo(50);
    expect(first.slowest).toBeCloseTo(50);

    const second = recordSpeed(first, 400, 2_000)!;
    expect(second.messages).toBe(2);
    expect(second.tokens).toBe(500);
    expect(second.peak).toBeCloseTo(200);
    expect(second.slowest).toBeCloseTo(50);

    const third = recordSpeed(second, 100, 10_000)!;
    expect(third.peak).toBeCloseTo(200);
    expect(third.slowest).toBeCloseTo(10);
  });

  it('refuses a message too short to separate speed from latency', () => {
    // A three-token "ok" behind 800 ms of network would pin the session's
    // "lowest" forever if it were allowed to count.
    expect(recordSpeed(emptySpeed(SESSION), MIN_SPEED_OUTPUT_TOKENS - 1, 800)).toBeUndefined();
    expect(recordSpeed(emptySpeed(SESSION), 0, 800)).toBeUndefined();
  });

  it('refuses a span that never elapsed (or a non-finite figure)', () => {
    expect(recordSpeed(emptySpeed(SESSION), 100, 0)).toBeUndefined();
    expect(recordSpeed(emptySpeed(SESSION), 100, -5)).toBeUndefined();
    expect(recordSpeed(emptySpeed(SESSION), Number.NaN, 100)).toBeUndefined();
    expect(recordSpeed(emptySpeed(SESSION), 100, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('leaves the accumulator untouched when a message is refused', () => {
    const prev = emptySpeed(SESSION);
    expect(recordSpeed(prev, 3, 800)).toBeUndefined();
    expect(prev.messages).toBe(0);
    expect(prev.tokens).toBe(0);
  });
});

describe('snapshotSpeed', () => {
  it('averages tokens over seconds across the whole session', () => {
    const stored = recordSpeed(emptySpeed(SESSION), 150, 3_000)!;
    const speed = snapshotSpeed(stored)!;
    expect(speed.avgTokensPerSecond).toBeCloseTo(50);
    expect(speed.peakTokensPerSecond).toBeCloseTo(50);
    expect(speed.slowestTokensPerSecond).toBeCloseTo(50);
  });

  it('is absent while nothing has been counted, so the panel shows — not 0/s', () => {
    expect(snapshotSpeed(undefined)).toBeUndefined();
    expect(snapshotSpeed(emptySpeed(SESSION))).toBeUndefined();
  });
});

describe('speed files', () => {
  it('round-trips a session accumulator and keeps the file keyed to it', async () => {
    const dataDir = await tempRoot();
    const stored = recordSpeed(recordSpeed(emptySpeed(SESSION), 100, 2_000)!, 400, 2_000)!;

    await saveSpeed(dataDir, stored);
    const loaded = await loadSpeed(dataDir, SESSION);

    expect(loaded).toEqual(stored);
    expect(speedFile(dataDir, SESSION)).toContain('speed');
    const raw = JSON.parse(await readFile(speedFile(dataDir, SESSION), 'utf8'));
    expect(raw.session).toBe(SESSION);
  });

  it('answers "no speed yet" for a session with no file', async () => {
    const dataDir = await tempRoot();
    expect(await loadSpeed(dataDir, SESSION)).toBeUndefined();
  });

  it('does not hand one session the accumulator of another', async () => {
    const dataDir = await tempRoot();
    await saveSpeed(dataDir, recordSpeed(emptySpeed(SESSION), 100, 2_000)!);
    expect(await loadSpeed(dataDir, OTHER)).toBeUndefined();
  });

  it('treats an unreadable or foreign file as nothing to restore', async () => {
    const dataDir = await tempRoot();
    const file = speedFile(dataDir, SESSION);
    const stored: StoredSessionSpeed = recordSpeed(emptySpeed(SESSION), 100, 2_000)!;

    await saveSpeed(dataDir, stored);
    writeFileSync(file, '{ not json');
    expect(await loadSpeed(dataDir, SESSION)).toBeUndefined();

    writeFileSync(file, JSON.stringify({ ...stored, version: 99 }));
    expect(await loadSpeed(dataDir, SESSION)).toBeUndefined();

    writeFileSync(file, JSON.stringify({ ...stored, tokens: 'many' }));
    expect(await loadSpeed(dataDir, SESSION)).toBeUndefined();
  });

  it('overwrites on the next message, so the totals never double', async () => {
    const dataDir = await tempRoot();
    const first = recordSpeed(emptySpeed(SESSION), 100, 2_000)!;
    await saveSpeed(dataDir, first);

    const loaded = await loadSpeed(dataDir, SESSION);
    const second = recordSpeed(loaded!, 100, 2_000)!;
    await saveSpeed(dataDir, second);

    expect((await loadSpeed(dataDir, SESSION))?.messages).toBe(2);
  });
});
