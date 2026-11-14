import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../logger.js';
import {
  CURRENT_DATA_LAYOUT,
  currentLayoutOf,
  maintainData,
  readDataVersion,
  type DataMigration,
} from './layout.js';

/**
 * The upgrade contract. What matters here is not any one migration but the rules
 * every migration inherits: forward one version at a time, stamped per step so an
 * interrupted upgrade resumes, idempotent on re-run, backed up before changing
 * anything, and refusing to open a directory a newer Morse wrote.
 */
describe('data layout maintenance', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morse-data-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const now = (): Date => new Date('2026-01-02T03:04:05.000Z');

  function step(to: number, run: () => void = () => undefined): DataMigration {
    return { to, name: `step ${to}`, run };
  }

  it('takes a fresh directory through every step and stamps it', () => {
    const migrations = [step(1), step(2)];

    const result = maintainData({
      root,
      logger: silentLogger,
      migrations,
      now,
      morseVersion: '1.0.0',
    });

    // A fresh install is layout 0: each step must tolerate an empty directory, so
    // the whole chain runs rather than a special case for "nothing to migrate".
    // It ends at the highest step this build knows, which is what the version
    // file records — that is how the next release knows where to pick up.
    expect(result).toEqual({
      from: 0,
      to: 2,
      applied: ['step 1', 'step 2'],
      warnings: [],
    });
    expect(readDataVersion(root)).toEqual({
      layout: 2,
      updatedAt: '2026-01-02T03:04:05.000Z',
      morse: '1.0.0',
    });
  });

  it('runs only the steps a directory is behind by', () => {
    writeFileSync(join(root, 'version.json'), JSON.stringify({ layout: 1, updatedAt: 'old' }));
    const ran: number[] = [];

    const result = maintainData({
      root,
      logger: silentLogger,
      migrations: [step(1), step(2, () => ran.push(2)), step(3, () => ran.push(3))],
      now,
    });

    expect(result).toMatchObject({ from: 1, to: 3, applied: ['step 2', 'step 3'] });
    expect(ran).toEqual([2, 3]);
    expect(readDataVersion(root).layout).toBe(3);
  });

  it('resumes from the last step that succeeded', () => {
    const done: number[] = [];
    const migrations = [
      step(1),
      step(2, () => done.push(2)),
      step(3, () => {
        throw new Error('disk full');
      }),
      step(4, () => done.push(4)),
    ];

    expect(() => maintainData({ root, logger: silentLogger, migrations, now })).toThrow(
      'disk full',
    );
    // The version stopped where the work stopped: the failing step is retried,
    // the ones before it are not replayed.
    expect(readDataVersion(root).layout).toBe(2);
    expect(done).toEqual([2]);

    const retried: number[] = [];
    maintainData({
      root,
      logger: silentLogger,
      migrations: [step(1), step(2), step(3, () => retried.push(3)), step(4)],
      now,
    });
    expect(retried).toEqual([3]);
    expect(readDataVersion(root).layout).toBe(4);
  });

  it('refuses a directory written by a newer Morse instead of downgrading it', () => {
    writeFileSync(
      join(root, 'version.json'),
      JSON.stringify({ layout: CURRENT_DATA_LAYOUT + 1, updatedAt: 'future' }),
    );

    expect(() => maintainData({ root, logger: silentLogger, migrations: [step(1)], now })).toThrow(
      /written by a newer Morse/,
    );
    // The file is untouched: refusing must not rewrite what it cannot understand.
    expect(readDataVersion(root).layout).toBe(CURRENT_DATA_LAYOUT + 1);
  });

  it('refuses a gap in the migration chain', () => {
    writeFileSync(join(root, 'version.json'), JSON.stringify({ layout: 1, updatedAt: 'old' }));

    expect(() =>
      maintainData({ root, logger: silentLogger, migrations: [step(1), step(3)], now }),
    ).toThrow(/No migration from data layout 1 to 3/);
  });

  it('refuses an unreadable version file rather than guessing the layout', () => {
    writeFileSync(join(root, 'version.json'), '{ not json');

    expect(() => maintainData({ root, logger: silentLogger, migrations: [step(1)], now })).toThrow(
      /Cannot read/,
    );
  });

  it('backs up the files a step is about to rewrite', () => {
    mkdirSync(join(root, 'bot', 'forge'), { recursive: true });
    writeFileSync(join(root, 'bot', 'registry.json'), '{"bots":[]}');
    let backedUp: string[] = [];
    const migration: DataMigration = {
      to: 1,
      name: 'changes the registry',
      run: (context) => {
        context.backup(['bot/registry.json', 'bot/forge/missing.json'], 'test');
        writeFileSync(join(root, 'bot', 'registry.json'), '{"bots":[],"migrated":true}');
      },
    };

    maintainData({ root, logger: silentLogger, migrations: [migration], now });

    const backupRoot = join(root, 'backups', 'test-2026-01-02T03-04-05-000Z');
    expect(readFileSync(join(backupRoot, 'bot', 'registry.json'), 'utf8')).toBe('{"bots":[]}');
    // A file that was not there is skipped, not invented.
    expect(() => readFileSync(join(backupRoot, 'bot', 'forge', 'missing.json'))).toThrow();
    backedUp = [backupRoot];
    expect(backedUp).toHaveLength(1);
  });

  it('runs the reconcile passes on every start, and never fails the host', () => {
    writeFileSync(join(root, 'version.json'), JSON.stringify({ layout: CURRENT_DATA_LAYOUT }));
    const repaired = vi.fn();
    const broken = vi.fn(() => {
      throw new Error('nothing to repair');
    });

    const result = maintainData({
      root,
      logger: silentLogger,
      migrations: [step(1), step(2)],
      reconciles: [
        { name: 'repair', run: repaired },
        { name: 'broken', run: broken },
      ],
      now,
    });

    expect(repaired).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual([]);
    expect(result.warnings).toEqual(['broken failed: nothing to repair']);
  });

  it('reports the layout a directory is at, and 0 when it has never been stamped', () => {
    expect(currentLayoutOf(root)).toBe(0);
    writeFileSync(join(root, 'version.json'), JSON.stringify({ layout: 2, updatedAt: 'x' }));
    expect(currentLayoutOf(root)).toBe(2);
  });
});
