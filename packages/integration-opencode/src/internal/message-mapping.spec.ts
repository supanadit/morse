import { describe, expect, it } from 'vitest';
import {
  messageEntries,
  sessionCountsOf,
  sessionSpeedOf,
  toForkMessages,
  toHistoryEntries,
  type ApiMessage,
} from './message-mapping.js';

/**
 * Payloads recorded from a 2.1.4 server's `GET /session/{id}/message`, trimmed to
 * the fields the mapping reads. The list is newest-first, as the server sends it.
 */

const USER: ApiMessage = {
  id: 'msg_171c484120010nGM35mj6Ic6Gs',
  time: { created: 1_000 },
  text: 'Use your shell tools to count the files, then reply with only the number.',
  type: 'user',
};

const ASSISTANT_WITH_TOOL: ApiMessage = {
  id: 'msg_171c48428001qos7fDugUEJFsa',
  time: { created: 1_001, streamed: 1_010, completed: 1_011 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'flint-40b-free', providerID: 'opencode' },
  content: [
    { type: 'reasoning', text: 'The user asks for a count. I should use shell.' },
    {
      type: 'tool',
      id: 'call_5e5b234418644902ae011b51',
      name: 'shell',
      executed: false,
      state: {
        status: 'completed',
        input: { command: 'ls -1 /tmp/opencode | wc -l' },
        content: [{ type: 'text', text: '5\n' }],
        metadata: { status: 'completed', truncated: false, exit: 0 },
      },
    },
  ],
};

const ASSISTANT_WITH_SUBAGENT: ApiMessage = {
  id: 'msg_171c48428001qos7fDugUEJFsa',
  time: { created: 1_001, streamed: 1_010, completed: 1_011 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'flint-40b-free', providerID: 'opencode' },
  content: [
    {
      type: 'tool',
      id: 'call_subagent_1',
      name: 'subagent',
      executed: false,
      state: {
        status: 'completed',
        // A build that reports the child only in the result text: the id
        // lives in the marker tag, the agent only in the delegation input.
        input: { agent: 'explore', description: 'Explore', prompt: 'Look around' },
        content: [
          { type: 'text', text: '<subagent sessionID="ses_kid" state="completed">\n# Overview\n' },
        ],
      },
    },
  ],
};

const ASSISTANT_TEXT: ApiMessage = {
  id: 'msg_171c48f9e0010tIKCiHKxzTDY1',
  time: { created: 1_012 },
  type: 'assistant',
  model: { id: 'flint-40b-free', providerID: 'opencode' },
  content: [
    { type: 'reasoning', text: 'The count returned 5.' },
    { type: 'text', text: '5' },
  ],
};

const COMPACTION_COMPLETED: ApiMessage = {
  type: 'compaction',
  id: 'msg_171c52e5d001oLS5z85SA5XxEd',
  time: { created: 1_020 },
  status: 'completed',
  reason: 'manual',
  model: { id: 'flint-40b-free', providerID: 'opencode' },
  summary: '## Objective\n- Count the files.',
  cost: 0,
  tokens: { input: 21_587, output: 641, reasoning: 0, cache: { read: 768, write: 0 } },
};

/** A failed compaction the server keeps in the same list. */
const COMPACTION_FAILED: ApiMessage = {
  type: 'compaction',
  id: 'msg_171c6762000130mStVEwFqjNmG',
  time: { created: 1_030 },
  status: 'failed',
  reason: 'manual',
  error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' },
};

const IDLE: ApiMessage = { id: 'msg_171c67631001xq1O1BYCJYgd91', time: { created: 1_031 }, type: 'idle', outcome: 'succeeded' };
const MODEL_SWITCHED: ApiMessage = {
  id: 'msg_171c67614001Kh0KCwZjc7E33M',
  time: { created: 1_029 },
  type: 'model-switched',
  model: { id: 'flint-40b-free', providerID: 'opencode' },
};

/** Two answers with the engine's own clock stamped: 100 tokens over 2s, then 50 over 0.5s. */
const TIMED_SLOW: ApiMessage = {
  id: 'msg_timed_1',
  type: 'assistant',
  time: { created: 1_000, completed: 3_000 },
  tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
  content: [{ type: 'text', text: 'one' }],
};
const TIMED_FAST: ApiMessage = {
  id: 'msg_timed_2',
  type: 'assistant',
  time: { created: 4_000, completed: 4_500 },
  tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
  content: [{ type: 'text', text: 'two' }],
};

describe('message mapping', () => {
  it('turns a user message into a forkable prompt entry', () => {
    expect(messageEntries(USER)).toEqual([{ role: 'user', text: USER.text, at: 1_000 }]);
  });

  it('turns one assistant message into its prose entry plus its tool rows', () => {
    const entries = messageEntries(ASSISTANT_WITH_TOOL);
    expect(entries.map((entry) => entry.role)).toEqual(['assistant', 'tool']);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: '',
      thinking: 'The user asks for a count. I should use shell.',
      model: 'opencode/flint-40b-free',
    });
    expect(entries[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_5e5b234418644902ae011b51',
      name: 'shell',
      title: 'shell: ls -1 /tmp/opencode | wc -l',
      status: 'ok',
      output: '5\n',
      details: { exit: 0 },
    });
    expect(entries[1]?.role === 'tool' ? entries[1].input : '').toContain('"command"');

    const textEntries = messageEntries(ASSISTANT_TEXT);
    expect(textEntries).toHaveLength(1);
    expect(textEntries[0]).toMatchObject({ role: 'assistant', text: '5', thinking: 'The count returned 5.' });
  });

  it('links a delegation row to the child its result text names', () => {
    const entries = messageEntries(ASSISTANT_WITH_SUBAGENT);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'tool',
      name: 'subagent',
      childSession: { sessionId: 'ses_kid', agent: 'explore' },
    });
  });

  it('records a completed compaction boundary and skips a failed one', () => {
    expect(messageEntries(COMPACTION_COMPLETED)).toEqual([
      {
        role: 'compaction',
        summary: '## Objective\n- Count the files.',
        tokensBefore: 21_587,
        at: 1_020,
      },
    ]);
    expect(messageEntries(COMPACTION_FAILED)).toEqual([]);
  });

  it('never reports bookkeeping rows as transcript content', () => {
    expect(messageEntries(IDLE)).toEqual([]);
    expect(messageEntries(MODEL_SWITCHED)).toEqual([]);
    // The whole page is bookkeeping, so it maps to nothing.
    expect(toHistoryEntries([IDLE, MODEL_SWITCHED, COMPACTION_FAILED])).toEqual([]);
  });

  it('keeps the newest-first page order while preserving each message\'s content order', () => {
    // The API sends newest first: idle, compaction, assistant, user.
    const page = [IDLE, COMPACTION_COMPLETED, ASSISTANT_TEXT, ASSISTANT_WITH_TOOL, USER];
    const entries = toHistoryEntries(page);
    expect(entries.map((entry) => entry.role)).toEqual([
      'compaction',
      'assistant',
      'assistant',
      'tool',
      'user',
    ]);
  });

  it('lists user prompts for forking in conversation order, including attachment-only ones', () => {
    const newestFirst = [
      { id: 'msg_c', time: { created: 3 }, type: 'user', text: 'third' },
      ASSISTANT_TEXT,
      { id: 'msg_b', time: { created: 2 }, type: 'user', text: '' },
      USER,
    ] satisfies ApiMessage[];
    expect(toForkMessages(newestFirst)).toEqual([
      { entryId: USER.id, text: USER.text },
      { entryId: 'msg_b', text: '' },
      { entryId: 'msg_c', text: 'third' },
    ]);
  });

  it('counts the usage panel totals from conversation rows only', () => {
    const counts = sessionCountsOf([
      IDLE,
      COMPACTION_COMPLETED,
      ASSISTANT_WITH_TOOL,
      ASSISTANT_TEXT,
      MODEL_SWITCHED,
      USER,
    ]);
    // The bookkeeping rows (idle, model-switched) and the compaction stay out:
    // only user and assistant messages are the conversation.
    expect(counts).toEqual({
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 3,
    });
  });

  it('times speed from the stored message clock and skips untimeable messages', () => {
    // ASSISTANT_WITH_TOOL carries no tokens; ASSISTANT_TEXT carries no clock;
    // both are skipped rather than counted as infinitely fast or slow.
    const speed = sessionSpeedOf([TIMED_FAST, TIMED_SLOW, ASSISTANT_WITH_TOOL, ASSISTANT_TEXT]);
    expect(speed).toEqual({
      avgTokensPerSecond: 60, // 150 tokens across 2.5s of generation
      peakTokensPerSecond: 100,
      slowestTokensPerSecond: 50,
    });
    expect(sessionSpeedOf([ASSISTANT_TEXT])).toBeUndefined();
  });
});
