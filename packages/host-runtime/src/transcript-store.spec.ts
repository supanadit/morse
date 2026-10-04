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

  /**
   * One store serves every connection, and every controller feeds the registry
   * events into it. Without the identity guard, two open clients projected the
   * same stream twice: doubled deltas, a duplicate `message_end` row, and a
   * `tool-start` whose first copy never saw `tool-end` (stuck on `running`).
   */
  it('applies an agent event once however many controllers write it', () => {
    const store = new SessionTranscriptStore();
    const events = [
      { type: 'agent/delta', at: 1, channel: 'thinking', delta: 'there' },
      { type: 'agent/message', at: 2, text: 'hi', thinking: 'there' },
      { type: 'agent/tool-start', at: 3, toolCallId: 'c1', name: 'read', title: 'read: a.ts' },
      { type: 'agent/tool-end', at: 4, toolCallId: 'c1', status: 'ok', output: 'done' },
    ] as const;

    // Two connections: each controller applies the same event instance.
    for (const event of events) {
      store.apply('s1', event);
      store.apply('s1', event);
    }

    const items = store.items('s1');
    expect(items.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    const tools = items.filter((item) => item.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: 'ok' });
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
