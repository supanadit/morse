import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@morse/agent';
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

/**
 * The reader switches models mid-conversation, so the store carries the session's
 * model alongside the transcript and hands it to the projector that stamps each
 * new assistant row. A model change never rewrites rows already written.
 */
describe('SessionTranscriptStore model', () => {
  const ZAI = { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' };
  const message = (text: string): AgentEvent => ({
    type: 'agent/message',
    at: 2,
    text,
    thinking: '',
  });

  it('stamps rows created after setModel, per session', () => {
    const store = new SessionTranscriptStore();
    store.setModel('s1', ZAI);
    store.userPrompt('s1', 'hello');
    store.apply('s1', message('hi'));
    store.userPrompt('s2', 'hey');
    store.apply('s2', message('yo'));

    expect(store.items('s1').at(-1)).toMatchObject({ kind: 'assistant', model: 'glm-5.3-flash' });
    expect(store.items('s2').at(-1)).not.toHaveProperty('model');
  });

  it('keeps the model for a projector created after setModel', () => {
    const store = new SessionTranscriptStore();
    store.setModel('s1', ZAI);
    store.userPrompt('s1', 'hello');
    store.apply('s1', message('hi'));

    expect(store.items('s1').at(-1)).toMatchObject({ model: 'glm-5.3-flash' });
  });

  it('drops the remembered model with the transcript', () => {
    const store = new SessionTranscriptStore();
    store.setModel('s1', ZAI);
    store.userPrompt('s1', 'hello');
    store.clear('s1');
    store.userPrompt('s1', 'again');
    store.apply('s1', message('hi'));

    expect(store.items('s1').at(-1)).not.toHaveProperty('model');
  });
});
