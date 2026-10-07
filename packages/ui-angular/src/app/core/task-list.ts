import type { ToolResultDetails, TranscriptItem } from '@morse/protocol';

/**
 * A task list recovered from a tool's structured result — by *shape*, never by
 * tool name.
 *
 * A pi extension can return `AgentToolResult.details` alongside its text. A todo
 * extension (rpiv-todo, and any other that follows the same convention) puts its
 * whole list there as `{ tasks: [{ id, subject, status, … }] }`. Morse forwards
 * `details` unchanged and this probe decides whether the transcript can render a
 * task board instead of just the one-line summary.
 *
 * The rule is deliberately structural: any tool whose `details.tasks` is an
 * array of task-shaped rows renders, whatever the tool is called. That keeps
 * Morse agnostic — there is no `toolName === 'todo'` anywhere, no import of a
 * specific plugin, and a future task tracker lights up for free. A tool that
 * returns an unrelated `tasks` array whose rows do not look like tasks is
 * rejected rather than mis-rendered.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

const TASK_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'deleted']);

export interface TaskRow {
  id: number;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
  blockedBy?: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One task-shaped row: numeric `id`, string `subject`, a known `status`. */
function toTaskRow(value: unknown): TaskRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value['id'];
  const subject = value['subject'];
  const status = value['status'];
  if (typeof id !== 'number' || typeof subject !== 'string' || typeof status !== 'string') {
    return undefined;
  }
  if (!TASK_STATUSES.has(status)) {
    return undefined;
  }
  const activeForm = value['activeForm'];
  const blockedBy = value['blockedBy'];
  return {
    id,
    subject,
    status: status as TaskStatus,
    ...(typeof activeForm === 'string' && activeForm.length > 0 ? { activeForm } : {}),
    ...(Array.isArray(blockedBy)
      ? { blockedBy: blockedBy.filter((entry): entry is number => typeof entry === 'number') }
      : {}),
  };
}

/**
 * A `tasks` array of task-shaped rows, or `undefined` when any entry is not a
 * task. Unlike `asTaskList` this accepts an *empty* array: the caller may need
 * to know that a tool reported "no tasks" (a `clear`), not that it reported
 * something that is not a task list at all.
 */
function parseTaskRows(tasks: unknown): TaskRow[] | undefined {
  if (!Array.isArray(tasks)) {
    return undefined;
  }
  const rows: TaskRow[] = [];
  for (const entry of tasks) {
    const row = toTaskRow(entry);
    if (!row) {
      return undefined;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Recover a task list from tool details, or `undefined` when the details are not
 * a task list. Every row must be task-shaped: a `tasks` array of something else
 * (a build matrix, say) is rejected so it is never presented as a todo board.
 *
 * An empty `tasks` array is rejected too: there is nothing to draw, and the
 * inline body should fall back to its ordinary input/output.
 */
export function asTaskList(details: ToolResultDetails | undefined): TaskRow[] | undefined {
  if (!details) {
    return undefined;
  }
  const rows = parseTaskRows(details['tasks']);
  return rows && rows.length > 0 ? rows : undefined;
}

/** Counts for a task-board heading, over the rows the probe accepted. */
export interface TaskCounts {
  total: number;
  done: number;
}

export function taskCounts(rows: readonly TaskRow[]): TaskCounts {
  return {
    total: rows.length,
    done: rows.filter((row) => row.status === 'completed').length,
  };
}

/**
 * The task list a session currently holds, recovered from its transcript by
 * shape alone.
 *
 * A todo-style tool returns its whole list on every call, so the *newest* tool
 * result whose details parse as a task list wins. Tombstoned rows are dropped,
 * because the persistent strip is about work, not bookkeeping. `open` counts
 * what is still to do (`pending`/`in_progress`) — the overlay exists only while
 * that is non-zero.
 */
export interface SessionTaskList {
  tasks: TaskRow[];
  total: number;
  done: number;
  open: number;
}

/**
 * The newest task list in a session's transcript, or `undefined` when no tool
 * has returned one.
 *
 * The walk stops at the first tool result that carries a task-shaped `tasks`
 * array — including an empty one, which is how a `clear` says "there is no
 * list". Non-task `details` (a diff, a build matrix) are skipped and the search
 * continues, so an unrelated tool between two todo calls cannot hide the list.
 */
export function sessionTaskList(
  items: readonly TranscriptItem[],
): SessionTaskList | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'tool') {
      continue;
    }
    const details = item.details;
    if (!details || !Array.isArray(details['tasks'])) {
      continue;
    }
    const rows = parseTaskRows(details['tasks']);
    if (!rows) {
      continue;
    }
    return summarizeTasks(rows);
  }
  return undefined;
}

function summarizeTasks(rows: readonly TaskRow[]): SessionTaskList {
  const live = rows.filter((row) => row.status !== 'deleted');
  return {
    tasks: live.map((row) => ({ ...row })),
    total: live.length,
    done: live.filter((row) => row.status === 'completed').length,
    open: live.filter((row) => row.status === 'pending' || row.status === 'in_progress').length,
  };
}
