import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@morse/agent';
import type { OpenCodeEvent } from './event-stream.js';
import { OpenCodeEventMapper, normalizeType } from './event-mapping.js';

/**
 * These fixtures are payloads recorded from a real OpenCode 2.1.4 server (the
 * `data` envelope, `session.*` names), trimmed to the fields the mapping reads.
 * They are the contract: the adapter is written against what the installed server
 * sends, not against the pre-release SDK's generated types.
 */

const SESSION = 'ses_e8e3b7bf8ffeAm7N4SdInOI5UU';

function event(type: string, data: Record<string, unknown>, created = 1_000): OpenCodeEvent {
  return { type, data: { sessionID: SESSION, ...data }, created };
}

/** A recorded text-only turn: thinking, a one-word answer, usage, settled. */
const TEXT_TURN: OpenCodeEvent[] = [
  event('session.execution.started', {}, 1_000),
  event('session.reasoning.started', { assistantMessageID: 'msg_1', ordinal: 0 }, 1_001),
  event('session.reasoning.delta', { assistantMessageID: 'msg_1', ordinal: 0, delta: 'The user asked to reply with exactly' }, 1_002),
  event('session.reasoning.delta', { assistantMessageID: 'msg_1', ordinal: 0, delta: ' the word "ping". Simple task — just reply with that.' }, 1_003),
  event('session.reasoning.ended', { assistantMessageID: 'msg_1', ordinal: 0, text: 'The user asked to reply with exactly the word "ping". Simple task — just reply with that.' }, 1_004),
  event('session.text.started', { assistantMessageID: 'msg_1', ordinal: 0 }, 1_004),
  event('session.text.delta', { assistantMessageID: 'msg_1', ordinal: 0, delta: 'ping' }, 1_005),
  event('session.text.ended', { assistantMessageID: 'msg_1', ordinal: 0, text: 'ping' }, 1_006),
  event('session.step.streamed', { assistantMessageID: 'msg_1' }, 1_007),
  event('session.step.ended', {
    assistantMessageID: 'msg_1',
    finish: 'stop',
    rawFinish: 'stop',
    cost: 0,
    tokens: { input: 6806, output: 249, reasoning: 0, cache: { read: 256, write: 0 } },
  }, 1_008),
  event('session.usage.updated', {
    cost: 0.0012,
    tokens: { input: 21587, output: 641, reasoning: 0, cache: { read: 768, write: 0 } },
  }, 1_009),
  event('session.execution.succeeded', {}, 1_010),
];

/** A recorded tool turn: a shell call between two assistant steps. */
const TOOL_TURN: OpenCodeEvent[] = [
  event('session.execution.started', {}, 2_000),
  event('session.reasoning.delta', { assistantMessageID: 'msg_2', ordinal: 0, delta: 'I should use shell.' }, 2_001),
  event('session.tool.input.started', { assistantMessageID: 'msg_2', id: 'call_5e5b', name: 'shell' }, 2_002),
  event('session.tool.input.ended', { assistantMessageID: 'msg_2', id: 'call_5e5b', text: '{"command": "ls -1 /tmp/opencode | wc -l"}' }, 2_003),
  event('session.tool.called', {
    assistantMessageID: 'msg_2',
    id: 'call_5e5b',
    input: { command: 'ls -1 /tmp/opencode | wc -l' },
    executed: false,
  }, 2_004),
  event('session.step.streamed', { assistantMessageID: 'msg_2' }, 2_005),
  event('session.tool.progress', { assistantMessageID: 'msg_2', id: 'call_5e5b', metadata: { shellID: 'sh_1' } }, 2_006),
  event('session.tool.success', {
    assistantMessageID: 'msg_2',
    id: 'call_5e5b',
    content: [{ type: 'text', text: '5\n' }],
    metadata: { status: 'completed', truncated: false, exit: 0 },
    executed: false,
  }, 2_007),
  event('session.step.ended', {
    assistantMessageID: 'msg_2',
    finish: 'tool-calls',
    cost: 0,
    tokens: { input: 6806, output: 249, reasoning: 0, cache: { read: 256, write: 0 } },
  }, 2_008),
  event('session.usage.updated', { cost: 0, tokens: { input: 6806, output: 249, reasoning: 0, cache: { read: 256, write: 0 } } }, 2_009),
  event('session.text.delta', { assistantMessageID: 'msg_3', ordinal: 0, delta: '5' }, 2_010),
  event('session.text.ended', { assistantMessageID: 'msg_3', ordinal: 0, text: '5' }, 2_011),
  event('session.step.streamed', { assistantMessageID: 'msg_3' }, 2_012),
  event('session.execution.succeeded', {}, 2_013),
];

/** Recorded manual compaction: deltas of the summary, then the finished summary. */
const COMPACTION: OpenCodeEvent[] = [
  event('session.execution.started', {}, 3_000),
  event('session.compaction.started', { reason: 'manual', inputID: 'msg_4' }, 3_001),
  event('session.compaction.delta', { text: '## Objective\n' }, 3_002),
  event('session.compaction.delta', { text: '- Count the files.' }, 3_003),
  event('session.compaction.ended', {
    reason: 'manual',
    model: { id: 'flint-40b-free', providerID: 'opencode' },
    text: '## Objective\n- Count the files.',
    tokens: { input: 21587, output: 641, reasoning: 0, cache: { read: 768, write: 0 } },
    cost: 0,
  }, 3_004),
  event('session.usage.updated', { cost: 0, tokens: { input: 21587, output: 641, reasoning: 0, cache: { read: 768, write: 0 } } }, 3_005),
  event('session.execution.succeeded', {}, 3_006),
];

function mapAll(events: readonly OpenCodeEvent[]): {
  events: AgentEvent[];
  states: Record<string, unknown>[];
} {
  const mapper = new OpenCodeEventMapper();
  const mapped: AgentEvent[] = [];
  const states: Record<string, unknown>[] = [];
  for (const input of events) {
    const record = mapper.map(input);
    mapped.push(...record.events);
    if (record.state !== undefined) {
      states.push(record.state as Record<string, unknown>);
    }
  }
  return { events: mapped, states };
}

describe('OpenCodeEventMapper', () => {
  it('turns a recorded text turn into a run with thinking, text and usage', () => {
    const { events, states } = mapAll(TEXT_TURN);

    expect(events.map((entry) => entry.type)).toEqual([
      'agent/run-start',
      'agent/delta',
      'agent/delta',
      'agent/delta',
      'agent/message',
      'agent/run-end',
    ]);
    const message = events.find((entry) => entry.type === 'agent/message');
    expect(message).toMatchObject({
      text: 'ping',
      thinking: 'The user asked to reply with exactly the word "ping". Simple task — just reply with that.',
    });
    expect(events.at(-1)).toMatchObject({ type: 'agent/run-end', reason: 'settled' });

    // The cumulative usage is a state patch; the per-step one is "last message".
    const usage = states.find((state) => state['usage'] !== undefined);
    expect(usage).toMatchObject({
      usage: {
        inputTokens: 21587,
        outputTokens: 641,
        totalTokens: 22228,
        cacheReadTokens: 768,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: 0.0012,
    });
    expect(states.some((state) => state['lastUsage'] !== undefined)).toBe(true);
    expect(states[0]).toMatchObject({ streaming: true });
    expect(states.at(-1)).toMatchObject({ streaming: false });
  });

  it('starts a tool row with a derived title, reports progress and carries the result', () => {
    const { events } = mapAll(TOOL_TURN);

    const start = events.find(
      (entry): entry is Extract<AgentEvent, { type: 'agent/tool-start' }> => entry.type === 'agent/tool-start',
    );
    expect(start).toMatchObject({
      toolCallId: 'call_5e5b',
      name: 'shell',
      title: 'shell: ls -1 /tmp/opencode | wc -l',
    });
    expect(start?.input).toContain('"command"');

    const update = events.find((entry) => entry.type === 'agent/tool-update');
    expect(update).toMatchObject({ toolCallId: 'call_5e5b', status: 'running' });

    const end = events.find(
      (entry): entry is Extract<AgentEvent, { type: 'agent/tool-end' }> => entry.type === 'agent/tool-end',
    );
    expect(end).toMatchObject({ toolCallId: 'call_5e5b', status: 'ok', output: '5\n' });
    expect(end?.details).toMatchObject({ exit: 0 });

    // The first step's thinking becomes a message before the tool row; the
    // second step's text becomes the next message.
    const messages = events.filter((entry) => entry.type === 'agent/message');
    expect(messages.map((entry) => (entry.type === 'agent/message' ? entry.text : ''))).toEqual(['', '5']);
    expect(messages[0]).toMatchObject({ thinking: 'I should use shell.' });
  });

  it('records a compaction boundary with its summary and folded context size', () => {
    const { events } = mapAll(COMPACTION);
    const marker = events.find(
      (entry): entry is Extract<AgentEvent, { type: 'agent/compaction' }> => entry.type === 'agent/compaction',
    );
    expect(marker).toMatchObject({ summary: '## Objective\n- Count the files.', tokensBefore: 21587 });
    // The compaction deltas are not a second assistant message.
    expect(events.filter((entry) => entry.type === 'agent/message')).toEqual([]);
  });

  it('ends a failed run once and says what failed', () => {
    const { events } = mapAll([
      event('session.execution.started', {}, 4_000),
      event('session.execution.failed', { error: 'provider overloaded' }, 4_001),
      // A repeated terminal event must not end the run a second time.
      event('session.execution.succeeded', {}, 4_002),
    ]);

    expect(events.filter((entry) => entry.type === 'agent/run-end')).toEqual([
      { type: 'agent/run-end', at: 4_001, reason: 'error' },
    ]);
    expect(events.find((entry) => entry.type === 'agent/notice')).toMatchObject({
      level: 'error',
      text: expect.stringContaining('provider overloaded'),
    });
  });

  it('reports a retry as a warning notice', () => {
    const { events } = mapAll([event('session.retried', { attempt: 2, reason: 'rate limited' }, 5_000)]);
    expect(events).toEqual([
      { type: 'agent/notice', at: 5_000, level: 'warn', text: expect.stringContaining('rate limited') },
    ]);
  });

  it('maps the session.next.* variant names exactly like the plain ones', () => {
    expect(normalizeType('session.next.text.delta')).toBe('session.text.delta');
    const { events } = mapAll([
      { type: 'session.next.execution.started', data: { sessionID: SESSION }, created: 6_000 },
      { type: 'session.next.text.delta', data: { sessionID: SESSION, delta: 'hi' }, created: 6_001 },
      { type: 'session.next.execution.succeeded', data: { sessionID: SESSION }, created: 6_002 },
    ]);
    expect(events.map((entry) => entry.type)).toEqual(['agent/run-start', 'agent/delta', 'agent/message', 'agent/run-end']);
  });

  it('synthesizes a missing tool start so a failed result is not lost', () => {
    const { events } = mapAll([
      event('session.execution.started', {}, 7_000),
      event('session.tool.input.started', { id: 'call_7', name: 'read' }, 7_001),
      event('session.tool.failed', { id: 'call_7', error: 'permission denied' }, 7_002),
      event('session.execution.succeeded', {}, 7_003),
    ]);
    expect(events.map((entry) => entry.type)).toEqual(['agent/run-start', 'agent/tool-start', 'agent/tool-end', 'agent/run-end']);
    expect(events[1]).toMatchObject({ toolCallId: 'call_7', name: 'read' });
    expect(events[2]).toMatchObject({ toolCallId: 'call_7', status: 'error', output: 'permission denied' });
  });

  it('reports a dead stream as agent/fatal and ignores a reconnect notice', () => {
    const { events } = mapAll([
      event('stream.fatal', { message: 'The OpenCode event stream is unavailable.' }, 8_000),
      event('stream.connected', {}, 8_001),
    ]);
    expect(events).toEqual([
      {
        type: 'agent/fatal',
        at: 8_000,
        message: 'The OpenCode event stream is unavailable.',
      },
    ]);
  });

  it('ignores the recorded bookkeeping events rather than inventing content', () => {
    // Every non-transcript type a real 2.1.4 server sent during a captured turn.
    const bookkeeping: OpenCodeEvent[] = [
      event('server.connected', {}),
      event('session.created', { slug: 'sunny-garden', version: '2.1.4' }),
      event('project.updated', { id: 'p1' }),
      event('session.inbox.enqueued', { inboxID: 'msg_1', item: { type: 'user' } }),
      event('session.inbox.delivered', { inboxID: 'msg_1' }),
      event('session.instructions.updated', { delta: { 'core/date': 'hash' } }),
      event('session.step.started', { agent: 'build', assistantMessageID: 'msg_1' }),
      event('session.text.started', { assistantMessageID: 'msg_1' }),
      event('shell.created', { info: { id: 'sh_1', command: 'ls' } }),
      event('shell.exited', { id: 'sh_1', exit: 0 }),
      event('some.unknown.future.event', { payload: true }),
    ];
    const { events, states } = mapAll(bookkeeping);
    expect(events).toEqual([]);
    expect(states).toEqual([]);
  });
});
