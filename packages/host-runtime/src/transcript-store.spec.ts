import { describe, expect, it } from 'vitest';
import { SessionTranscriptStore } from './transcript-store.js';

/**
 * The store sits between the projector and the controller. Two things matter here:
 * every update reaches a subscriber with its message, and the transcript copy in
 * the update is *lazy* — the controller only forwards `message`, and copying every
 * item on every delta was measurable garbage on a long conversation.
 */
describe('SessionTranscriptStore', () => {
  it('gives a subscriber the message, and the transcript as of that update', () => {
    const store = new SessionTranscriptStore();
    const seen: { type: string; items: number }[] = [];
    store.subscribe((update) => seen.push({ type: update.message.type, items: update.items.length }));

    store.userPrompt('s1', 'hello');
    store.notice('s1', 'info', 'noted');

    expect(seen).toEqual([
      { type: 'transcript/append', items: 1 },
      { type: 'transcript/append', items: 2 },
    ]);
  });

  it('keeps transcripts and paging cursors per session, and drops both on clear', () => {
    const store = new SessionTranscriptStore();
    store.userPrompt('s1', 'one');
    store.userPrompt('s2', 'two');
    store.setHistoryCursor('s1', { before: 'x', hasOlder: true });

    expect(store.items('s1')).toHaveLength(1);
    expect(store.items('s2')).toHaveLength(1);
    expect(store.historyCursor('s1')).toEqual({ before: 'x', hasOlder: true });
    // A session that was never touched has no cursor of its own.
    expect(store.historyCursor('s3')).toEqual({ hasOlder: false });

    store.clear('s1');
    expect(store.items('s1')).toEqual([]);
    expect(store.historyCursor('s1')).toEqual({ hasOlder: false });
    expect(store.items('s2')).toHaveLength(1);
  });

  it('replays the snapshot it was asked for while a session is warm', () => {
    const store = new SessionTranscriptStore();
    store.seed('s1', [
      { kind: 'user', id: 'u1', at: 1, text: 'hi' },
      { kind: 'assistant', id: 'a1', at: 2, text: 'hello', thinking: '', streaming: false },
    ]);

    expect(store.items('s1').map((item) => item.kind)).toEqual(['user', 'assistant']);
    // A copy, not the projector's own array.
    store.items('s1').push({ kind: 'notice', id: 'n1', at: 3, level: 'info', text: 'x' });
    expect(store.items('s1')).toHaveLength(2);
  });
});
