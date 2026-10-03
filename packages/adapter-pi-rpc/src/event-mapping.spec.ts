import { describe, expect, it } from 'vitest';
import type { AgentHistoryEntry } from '@morse/core';
import { activePathEntries, mapSessionEvent, toHistory, toEntryHistory } from './event-mapping.js';

const ISO_1 = '2026-01-01T00:00:01.000Z';
const ISO_2 = '2026-01-01T00:00:02.000Z';
const ISO_3 = '2026-01-01T00:00:03.000Z';
const ISO_4 = '2026-01-01T00:00:04.000Z';

function messageEntry(
  id: string,
  parentId: string | null,
  timestamp: string,
  message: Record<string, unknown>,
): Record<string, unknown> {
  return { type: 'message', id, parentId, timestamp, message };
}

const roles = (history: AgentHistoryEntry[]): string[] => history.map((entry) => entry.role);

describe('toEntryHistory', () => {
  it('keeps the full pre-compaction history and marks the boundary in place', () => {
    const history = toEntryHistory([
      messageEntry('e1', null, ISO_1, {
        role: 'user',
        content: [{ type: 'text', text: 'build me a tree' }],
        timestamp: 1_000,
      }),
      messageEntry('e2', 'e1', ISO_2, {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 2_000,
      }),
      messageEntry('e3', 'e2', ISO_3, {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'README.md' }],
        isError: false,
        timestamp: 3_000,
      }),
      {
        type: 'compaction',
        id: 'e4',
        parentId: 'e3',
        timestamp: ISO_4,
        summary: '## Summary\n\nBuilt a tree.',
        firstKeptEntryId: 'e3',
        tokensBefore: 150_000,
      },
      messageEntry('e5', 'e4', ISO_4, {
        role: 'user',
        content: [{ type: 'text', text: 'now paint it' }],
        timestamp: 5_000,
      }),
    ]);

    expect(roles(history)).toEqual(['user', 'assistant', 'tool', 'compaction', 'user']);
    const marker = history.find(
      (entry): entry is Extract<AgentHistoryEntry, { role: 'compaction' }> =>
        entry.role === 'compaction',
    );
    expect(marker?.summary).toContain('Built a tree.');
    expect(marker?.tokensBefore).toBe(150_000);
    // The ISO entry timestamp became a Unix-ms one.
    expect(marker?.at).toBe(Date.parse(ISO_4));
    // The folded tool call still carries its result across the marker.
    const tool = history.find(
      (entry): entry is Extract<AgentHistoryEntry, { role: 'tool' }> => entry.role === 'tool',
    );
    expect(tool).toMatchObject({ name: 'bash', output: 'README.md', status: 'ok' });
  });

  it('renders branch summaries as user entries', () => {
    const history = toEntryHistory([
      {
        type: 'branch_summary',
        id: 'e2',
        parentId: 'e1',
        timestamp: ISO_1,
        summary: 'The user tried the first design.',
      },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      role: 'user',
      text: expect.stringContaining('explored another branch'),
    });
  });

  it('ignores the plumbing entries between messages', () => {
    const history = toEntryHistory([
      messageEntry('e1', null, ISO_1, {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        timestamp: 1_000,
      }),
      { type: 'usage', id: 'e2', parentId: 'e1', timestamp: ISO_2, kind: 'cache_warm' },
      { type: 'model_change', id: 'e3', parentId: 'e2', timestamp: ISO_3, modelId: 'm' },
      { type: 'session_info', id: 'e4', parentId: 'e3', timestamp: ISO_4 },
      { type: 'custom_message', id: 'e5', parentId: 'e4', timestamp: ISO_4, content: 'x' },
    ]);
    expect(roles(history)).toEqual(['user']);
  });
});

describe('activePathEntries', () => {
  const all = [
    messageEntry('a', null, ISO_1, { role: 'user', content: [] }),
    // An abandoned branch: the user edited the prompt, this turn died.
    messageEntry('abandoned', 'a', ISO_2, { role: 'assistant', content: [] }),
    messageEntry('b', 'a', ISO_2, { role: 'assistant', content: [] }),
    messageEntry('c', 'b', ISO_3, { role: 'user', content: [] }),
  ];

  it('walks back from the leaf and drops abandoned branches', () => {
    const path = activePathEntries({ entries: all, leafId: 'c' });
    expect(path).toHaveLength(3);
  });

  it('falls back to everything when the leaf is unknown', () => {
    expect(activePathEntries({ entries: all, leafId: 'missing' })).toEqual(all);
    expect(activePathEntries({ entries: all })).toEqual(all);
    expect(activePathEntries(undefined)).toEqual([]);
  });
});

describe('mapSessionEvent compaction_end', () => {
  it('records the boundary as a marker event with the summary the agent keeps', () => {
    const mapped = mapSessionEvent(
      { type: 'compaction_end', result: { summary: '## Summary', tokensBefore: 900 } },
      () => 7,
    );
    expect(mapped.events).toEqual([
      { type: 'agent/compaction', at: 7, summary: '## Summary', tokensBefore: 900 },
    ]);
  });

  it('aborted and failed compactions stay notices', () => {
    expect(mapSessionEvent({ type: 'compaction_end', aborted: true }, () => 7).events).toEqual([
      { type: 'agent/notice', at: 7, level: 'warn', text: 'Compaction was aborted.' },
    ]);
    expect(
      mapSessionEvent({ type: 'compaction_end', errorMessage: 'boom' }, () => 7).events,
    ).toEqual([{ type: 'agent/notice', at: 7, level: 'error', text: 'Compaction failed: boom' }]);
  });
});

describe('toHistory (a flat `get_messages` list)', () => {
  it('still pairs tool results with their calls', () => {
    const history = toHistory([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read' }], timestamp: 1_000 },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'contents' }],
        isError: false,
      },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: 'tool', output: 'contents' });
  });
});