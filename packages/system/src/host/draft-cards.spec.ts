import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftCardStore } from './draft-cards.js';
import { silentLogger } from '../logger.js';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'morse-draft-cards-'));
  const store = new DraftCardStore(dataDir, silentLogger);
  return { store, dataDir };
}

describe('DraftCardStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips cards through the data dir', () => {
    const { store, dataDir } = setup();
    dirs.push(dataDir);
    store.set('draft-1', {
      engine: 'pi',
      model: { provider: 'mock', id: 'plain', name: 'Plain' },
      thinking: 'low',
      mode: 'build',
    });

    const reopened = new DraftCardStore(dataDir, silentLogger);
    expect(reopened.all()).toEqual({
      'draft-1': {
        engine: 'pi',
        model: { provider: 'mock', id: 'plain', name: 'Plain' },
        thinking: 'low',
        mode: 'build',
      },
    });
  });

  it('an empty card forgets the tab, and a delete drops it', () => {
    const { store, dataDir } = setup();
    dirs.push(dataDir);
    store.set('draft-1', { engine: 'pi' });
    store.set('draft-1', {});
    expect(store.all()).toEqual({});
    store.set('draft-2', { mode: 'build' });
    store.delete('draft-2');
    expect(store.all()).toEqual({});
  });

  it('ignores a corrupt file instead of losing the session', () => {
    const { dataDir } = setup();
    dirs.push(dataDir);
    writeFileSync(join(dataDir, 'draft-cards.json'), '{nope', 'utf8');
    const reopened = new DraftCardStore(dataDir, silentLogger);
    expect(reopened.all()).toEqual({});
  });

  it('drops malformed cards but keeps the good ones', () => {
    const { dataDir } = setup();
    dirs.push(dataDir);
    writeFileSync(
      join(dataDir, 'draft-cards.json'),
      JSON.stringify({ version: 1, data: { cards: { bad: 42, good: { engine: 'pi' } } } }),
      'utf8',
    );
    const reopened = new DraftCardStore(dataDir, silentLogger);
    expect(reopened.all()).toEqual({ good: { engine: 'pi' } });
  });

  it('works without a data dir, in memory only', () => {
    const store = new DraftCardStore(undefined, silentLogger);
    store.set('draft-1', { engine: 'pi' });
    expect(store.all()).toEqual({ 'draft-1': { engine: 'pi' } });
  });
});
