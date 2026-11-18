import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BotTurnTrace } from '@morse/protocol';
import { writeJsonAtomic } from './store.js';

/** How long a finished turn stays readable: a week of a room's history. */
export const TRACE_TTL_MS = 604_800_000;

/** How many turns one room keeps; the oldest go first once history piles up. */
export const TRACE_LIMIT = 100;

/**
 * A conversation's finished turns, kept on disk beside its transcript.
 *
 * One JSON array per conversation at `<dir>/<conversationId>.json`, the same
 * layout as the delivery store: a DM's id and a group's id are both stable and
 * directory-safe, so the file name is the key. The whole array is rewritten on
 * every change and the write is atomic, so a crash leaves the previous history
 * intact instead of a truncated one.
 *
 * A trace is history for the person reading the room, never context for an
 * engine: nothing here is put into a prompt, and nothing here is read by a bot.
 * That is why this store only stores and serves — there is no status to move and
 * no queue to drain. A turn is written once, when it settles, so a row never
 * changes after `add` except to be replaced by the same turn written again.
 *
 * The directory is this store's own: a sweep reads every `*.json` in it as a
 * conversation's history, so it must not be shared with the registry, the
 * delivery store or any other JSON.
 */
export class BotTraceStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Every trace in a conversation, oldest first. A missing file is a room with
   * no finished turn yet, not an error: it reads as an empty history. A
   * present-but-malformed file throws instead, so a broken history is never
   * mistaken for an empty one and then overwritten by the next add.
   */
  all(conversationId: string): BotTurnTrace[] {
    return this.read(conversationId);
  }

  /**
   * Records one finished turn. A turn id that is already stored replaces its
   * row rather than being appended beside it: the id is the delivery's, and one
   * turn is one trace, so a duplicate would be the same turn twice.
   *
   * The rows are sorted by `endedAt` after every add, so the file is the history
   * in the order it happened even when a turn finishes out of order.
   */
  add(trace: BotTurnTrace): void {
    const rows = this.read(trace.conversationId);
    const at = rows.findIndex((row) => row.id === trace.id);
    if (at === -1) {
      rows.push(trace);
    } else {
      rows[at] = trace;
    }
    rows.sort((left, right) => left.endedAt - right.endedAt);
    this.write(trace.conversationId, rows);
  }

  /** Removes a conversation's history, for a conversation that no longer exists. */
  forget(conversationId: string): void {
    rmSync(this.pathFor(conversationId), { force: true });
  }

  /**
   * Ages every conversation's history: a turn that ended before `now` minus the
   * TTL is dropped, and a room keeps only its newest `TRACE_LIMIT` turns.
   *
   * One unreadable file must not stop the rest from being pruned: this is
   * housekeeping, and leaving every other room growing because one file is
   * corrupt is worse than finishing the sweep and reporting that one file. The
   * failure is still loud — it is collected here and thrown once the loop is
   * done, as the delivery store does.
   */
  prune(now: number): void {
    const cutoff = now - TRACE_TTL_MS;
    const failures: string[] = [];
    for (const conversationId of this.conversations()) {
      try {
        const rows = this.read(conversationId);
        // The filter hands out a fresh array, so sorting it cannot reorder the
        // rows read above; the same row objects make the change test below a
        // reference comparison.
        const kept = rows
          .filter((row) => row.endedAt >= cutoff)
          .sort((left, right) => left.endedAt - right.endedAt)
          .slice(-TRACE_LIMIT);
        if (kept.length !== rows.length || kept.some((row, index) => row !== rows[index])) {
          this.write(conversationId, kept);
        }
      } catch (error) {
        failures.push(this.describeFailure(conversationId, error));
      }
    }
    failIfAny('prune bot traces', failures);
  }

  /** Every conversation this store holds a history for. */
  private conversations(): string[] {
    if (!existsSync(this.dir)) {
      return [];
    }
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  }

  /** A sweep failure, named by the file it could not handle. */
  private describeFailure(conversationId: string, error: unknown): string {
    return `${this.filePath(conversationId)}: ${(error as Error).message}`;
  }

  /** Where a history would live, even when its id is too unsafe to read. */
  private filePath(conversationId: string): string {
    return join(this.dir, `${conversationId}.json`);
  }

  private pathFor(conversationId: string): string {
    // The id comes from Morse's own registry (a DM's username or a generated
    // group id), but it is still validated here: this value becomes a path.
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_-]*$/.test(conversationId)) {
      throw new Error(`"${conversationId}" is not a usable conversation id.`);
    }
    return this.filePath(conversationId);
  }

  private read(conversationId: string): BotTurnTrace[] {
    const path = this.pathFor(conversationId);
    if (!existsSync(path)) {
      return [];
    }
    const raw = readFileSync(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
    }
    if (!Array.isArray(parsed) || !parsed.every(isTrace)) {
      throw new Error(`Cannot read ${path}: expected a list of bot turn traces.`);
    }
    return parsed;
  }

  private write(conversationId: string, rows: BotTurnTrace[]): void {
    writeJsonAtomic(this.pathFor(conversationId), rows);
  }
}

const STATUSES: readonly BotTurnTrace['status'][] = ['done', 'failed', 'cancelled'];

/**
 * The minimum a stored row must carry for the page to draw it. Deliberately not
 * a full step-by-step schema: a `null` or a missing required field would fail
 * later, while the page is being read, so the file is refused here with its path
 * instead. `steps` and `handoffs` are checked as lists because a row without
 * them still type-checks as a trace and would break the reader mid-render.
 */
function isTrace(value: unknown): value is BotTurnTrace {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['id'] === 'string' &&
    typeof row['conversationId'] === 'string' &&
    typeof row['username'] === 'string' &&
    typeof row['name'] === 'string' &&
    typeof row['startedAt'] === 'number' &&
    typeof row['endedAt'] === 'number' &&
    typeof row['status'] === 'string' &&
    STATUSES.includes(row['status'] as BotTurnTrace['status']) &&
    Array.isArray(row['steps']) &&
    Array.isArray(row['handoffs'])
  );
}

/**
 * Reports every file a sweep could not handle, after the sweep has finished.
 * Failing loudly is deliberate — a corrupt history must be repaired, not
 * ignored — but it must not be all-or-nothing: one bad file should not leave
 * every other room's history unpruned.
 */
function failIfAny(action: string, failures: string[]): void {
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    `Cannot ${action}: ${failures.length} trace file(s) failed — ${failures.join(' | ')}`,
  );
}
