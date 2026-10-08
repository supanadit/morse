import type { ToolTranscriptItem, TranscriptItem } from '@morse/protocol';
import { describe, expect, it } from 'vitest';
import { asTaskList, sessionTaskList, taskCounts } from './tasks.js';

/**
 * The probe decides whether a tool's structured result can be shown as a task
 * board. It is shape-only on purpose: no test here references a tool or plugin
 * name, which is what keeps Morse agnostic.
 */
describe('asTaskList', () => {
  it('accepts a task list by shape', () => {
    expect(
      asTaskList({
        action: 'create',
        tasks: [
          { id: 1, subject: 'Create entity', status: 'completed', activeForm: 'creating it' },
          { id: 2, subject: 'Wire repo', status: 'in_progress', blockedBy: [1] },
          { id: 3, subject: 'Test', status: 'pending' },
        ],
      }),
    ).toEqual([
      { id: 1, subject: 'Create entity', status: 'completed', activeForm: 'creating it' },
      { id: 2, subject: 'Wire repo', status: 'in_progress', blockedBy: [1] },
      { id: 3, subject: 'Test', status: 'pending' },
    ]);
  });

  it('accepts a list even when it is nested beside unrelated keys', () => {
    const rows = asTaskList({ nextId: 9, params: { action: 'list' }, tasks: [{ id: 1, subject: 'x', status: 'pending' }] });
    expect(rows).toHaveLength(1);
  });

  it('keeps a deleted tombstone so the board can decide what to hide', () => {
    expect(asTaskList({ tasks: [{ id: 1, subject: 'gone', status: 'deleted' }] })?.[0]?.status).toBe('deleted');
  });

  it('rejects details with no tasks array', () => {
    expect(asTaskList({ action: 'clear', count: 2 })).toBeUndefined();
    expect(asTaskList(undefined)).toBeUndefined();
  });

  it('rejects an empty list', () => {
    expect(asTaskList({ tasks: [] })).toBeUndefined();
  });

  it('rejects an unrelated tasks array so it is never shown as todos', () => {
    // A CI/build matrix also calls them "tasks" — not a task list.
    expect(asTaskList({ tasks: [{ name: 'build', runner: 'linux' }] })).toBeUndefined();
  });

  it('rejects a list where only some rows are task-shaped', () => {
    expect(
      asTaskList({
        tasks: [
          { id: 1, subject: 'ok', status: 'pending' },
          { id: 2, subject: 'no status' },
        ],
      }),
    ).toBeUndefined();
  });

  it('rejects an unknown status value', () => {
    expect(asTaskList({ tasks: [{ id: 1, subject: 'x', status: 'blocked' }] })).toBeUndefined();
  });

  it('drops a non-numeric blockedBy entry rather than failing the row', () => {
    expect(
      asTaskList({ tasks: [{ id: 2, subject: 'x', status: 'pending', blockedBy: [1, 'nope'] }] })?.[0]?.blockedBy,
    ).toEqual([1]);
  });
});

describe('taskCounts', () => {
  it('counts completed against the total', () => {
    const rows = asTaskList({
      tasks: [
        { id: 1, subject: 'a', status: 'completed' },
        { id: 2, subject: 'b', status: 'in_progress' },
        { id: 3, subject: 'c', status: 'pending' },
      ],
    });
    expect(taskCounts(rows ?? [])).toEqual({ total: 3, done: 1 });
  });
});

function tool(id: string, details: unknown): ToolTranscriptItem {
  return {
    kind: 'tool',
    id,
    at: 0,
    name: 'anything',
    title: 'anything',
    status: 'ok',
    details: details as ToolTranscriptItem['details'],
  };
}

function user(id: string): TranscriptItem {
  return { kind: 'user', id, at: 0, text: 'hi' };
}

/**
 * The persistent overlay's selector. It must find the *newest* task list in the
 * transcript by shape alone and report how much work is still open.
 */
describe('sessionTaskList', () => {
  it('returns the newest task-shaped result, ignoring unrelated tool details', () => {
    const items: TranscriptItem[] = [
      user('u1'),
      tool('t1', { tasks: [{ id: 1, subject: 'old', status: 'pending' }] }),
      tool('t2', { diff: 'not a task list' }),
      tool('t3', {
        tasks: [
          { id: 1, subject: 'new', status: 'completed' },
          { id: 2, subject: 'still open', status: 'in_progress' },
        ],
      }),
    ];

    const list = sessionTaskList(items);
    expect(list?.total).toBe(2);
    expect(list?.done).toBe(1);
    expect(list?.open).toBe(1);
    expect(list?.tasks.map((task) => task.subject)).toEqual(['new', 'still open']);
  });

  it('drops tombstoned rows and counts open work as pending plus in_progress', () => {
    const list = sessionTaskList([
      tool('t1', {
        tasks: [
          { id: 1, subject: 'a', status: 'completed' },
          { id: 2, subject: 'b', status: 'pending' },
          { id: 3, subject: 'c', status: 'in_progress' },
          { id: 4, subject: 'd', status: 'deleted' },
        ],
      }),
    ]);
    expect(list).toEqual({
      tasks: [
        { id: 1, subject: 'a', status: 'completed' },
        { id: 2, subject: 'b', status: 'pending' },
        { id: 3, subject: 'c', status: 'in_progress' },
      ],
      total: 3,
      done: 1,
      open: 2,
    });
  });

  it('reports a finished list (open 0) so the overlay can auto-hide', () => {
    const list = sessionTaskList([
      tool('t1', { tasks: [{ id: 1, subject: 'a', status: 'completed' }] }),
    ]);
    expect(list?.open).toBe(0);
  });

  it('treats an empty tasks array as "no list", not as a task list', () => {
    // A `clear` reports zero tasks: the overlay should disappear, and the search
    // must not fall back to an older list either.
    expect(sessionTaskList([tool('t1', { tasks: [] })])).toEqual({
      tasks: [],
      total: 0,
      done: 0,
      open: 0,
    });
  });

  it('ignores a non-task `tasks` array (a build matrix) and keeps searching', () => {
    const list = sessionTaskList([
      tool('t1', { tasks: [{ name: 'build', runner: 'linux' }] }),
      tool('t2', { tasks: [{ id: 1, subject: 'real', status: 'pending' }] }),
    ]);
    expect(list?.tasks.map((task) => task.subject)).toEqual(['real']);
  });

  it('returns undefined when no tool carried a task list', () => {
    expect(sessionTaskList([user('u1'), tool('t1', { output: 'plain' })])).toBeUndefined();
    expect(sessionTaskList([])).toBeUndefined();
  });
});
