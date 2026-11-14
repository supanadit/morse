import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotTranscriptEntry } from '@morse/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotTranscriptStore } from './transcripts.js';

/**
 * A bot conversation outlives the host: its transcript is a file, not a map. What
 * matters here is durability (a restart keeps the history), paging (the chat opens
 * at the end and grows backwards) and the discussion divider that keeps engine
 * sessions apart inside one scroll.
 */
describe('BotTranscriptStore', () => {
  let botRoot: string;

  beforeEach(() => {
    botRoot = mkdtempSync(join(tmpdir(), 'morse-transcripts-'));
  });

  afterEach(() => {
    rmSync(botRoot, { recursive: true, force: true });
  });

  function entry(text: string, at = 1): BotTranscriptEntry {
    return { id: `id-${text}`, author: { role: 'system' }, text, at };
  }

  it('keeps the transcript across a restart', () => {
    const first = new BotTranscriptStore(botRoot);
    first.append('dm-forge', entry('one'));
    first.append('dm-forge', entry('two'));

    // A new store is a new process: nothing in memory survives but the file.
    const second = new BotTranscriptStore(botRoot);

    expect(second.all('dm-forge').map((one) => one.text)).toEqual(['one', 'two']);
    expect(second.conversations()).toEqual(['dm-forge']);
  });

  it('opens on the newest page and pages backwards', () => {
    const store = new BotTranscriptStore(botRoot);
    for (let index = 1; index <= 5; index += 1) {
      store.append('dm-forge', entry(String(index)));
    }

    const latest = store.latest('dm-forge', 2);
    expect(latest.entries.map((one) => one.text)).toEqual(['4', '5']);
    expect(latest.hasMore).toBe(true);

    const before = store.before('dm-forge', 'id-4', 2);
    expect(before.entries.map((one) => one.text)).toEqual(['2', '3']);
    expect(before.hasMore).toBe(true);

    const first = store.before('dm-forge', 'id-2', 2);
    expect(first.entries.map((one) => one.text)).toEqual(['1']);
    expect(first.hasMore).toBe(false);
  });

  it('answers an unknown cursor with the newest page rather than nothing', () => {
    const store = new BotTranscriptStore(botRoot);
    store.append('dm-forge', entry('only'));

    // A transcript rewritten while the chat was open: losing the reader's place
    // is better than showing an empty window.
    expect(store.before('dm-forge', 'gone', 10).entries.map((one) => one.text)).toEqual(['only']);
  });

  it('survives a half-written last line', () => {
    const store = new BotTranscriptStore(botRoot);
    store.append('dm-forge', entry('kept'));
    // A process killed mid-append leaves a partial line: it must cost that entry
    // only, never the transcript before it.
    writeFileSync(join(botRoot, 'transcripts', 'dm-forge.jsonl'), 'not json\n', { flag: 'a' });

    expect(new BotTranscriptStore(botRoot).all('dm-forge').map((one) => one.text)).toEqual([
      'kept',
    ]);
  });

  it('writes the transcript as one JSON line per entry', () => {
    const store = new BotTranscriptStore(botRoot);
    store.append('dm-forge', entry('one'));
    store.append('dm-forge', entry('two'));

    const lines = readFileSync(join(botRoot, 'transcripts', 'dm-forge.jsonl'), 'utf8')
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ text: 'two' });
  });

  it('records a discussion boundary as a divider entry', () => {
    const store = new BotTranscriptStore(botRoot);
    store.append('dm-forge', entry('before'));
    store.appendDivider('dm-forge', 5);
    store.append('dm-forge', entry('after'));

    expect(store.all('dm-forge').map((one) => one.author.role)).toEqual([
      'system',
      'discussion',
      'system',
    ]);
  });

  it('forgets a conversation when asked, and refuses an unusable id', () => {
    const store = new BotTranscriptStore(botRoot);
    store.append('dm-forge', entry('one'));
    store.forget('dm-forge');
    expect(store.all('dm-forge')).toEqual([]);

    // The id becomes a path, so it is validated even though Morse generates it.
    expect(() => store.all('../escape')).toThrow('not a usable conversation id');
  });
});
