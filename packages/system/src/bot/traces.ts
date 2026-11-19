import type { BotTurnTrace } from '@morse/protocol';
import { ConversationFiles, failIfAny } from './conversation-files.js';

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
 * delivery store or any other JSON. The file plumbing itself is shared with the
 * delivery store (`ConversationFiles`), so the id rule and the read contract
 * cannot drift between the two; what differs here is the row validator and the
 * TTL/cap policy.
 */
export class BotTraceStore {
  private readonly files: ConversationFiles<BotTurnTrace>;

  constructor(dir: string) {
    this.files = new ConversationFiles<BotTurnTrace>(dir, 'a list of bot turn traces', isTrace);
  }

  /**
   * Every trace in a conversation, oldest first. A missing file is a room with
   * no finished turn yet, not an error: it reads as an empty history. A
   * present-but-malformed file throws instead, so a broken history is never
   * mistaken for an empty one and then overwritten by the next add.
   */
  all(conversationId: string): BotTurnTrace[] {
    return this.files.all(conversationId);
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
    const rows = this.files.all(trace.conversationId);
    const at = rows.findIndex((row) => row.id === trace.id);
    if (at === -1) {
      rows.push(trace);
    } else {
      rows[at] = trace;
    }
    rows.sort((left, right) => left.endedAt - right.endedAt);
    this.files.write(trace.conversationId, rows);
  }

  /** Removes a conversation's history, for a conversation that no longer exists. */
  forget(conversationId: string): void {
    this.files.forget(conversationId);
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
    for (const conversationId of this.files.conversations()) {
      try {
        const rows = this.files.all(conversationId);
        // The filter hands out a fresh array, so sorting it cannot reorder the
        // rows read above; the same row objects make the change test below a
        // reference comparison.
        const kept = rows
          .filter((row) => row.endedAt >= cutoff)
          .sort((left, right) => left.endedAt - right.endedAt)
          .slice(-TRACE_LIMIT);
        if (kept.length !== rows.length || kept.some((row, index) => row !== rows[index])) {
          this.files.write(conversationId, kept);
        }
      } catch (error) {
        failures.push(this.files.failure(conversationId, error));
      }
    }
    failIfAny('prune bot traces', failures, 'trace');
  }
}

const STATUSES: readonly BotTurnTrace['status'][] = ['done', 'failed', 'cancelled'];

/**
 * The minimum a stored row must carry for the page to draw it. Deliberately not
 * a full step-by-step schema: a `null` or a missing required field would fail
 * later, while the page is being read, so the file is refused here with its path
 * instead. `steps` and `handoffs` are checked as lists because a row without
 * them still type-checks as a trace and would break the reader mid-render; a
 * `reply` is checked whole for the same reason — the page prints its words and
 * its time, and half a reply would throw inside the render.
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
    Array.isArray(row['handoffs']) &&
    isReply(row['reply'])
  );
}

function isReply(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['username'] === 'string' &&
    typeof row['name'] === 'string' &&
    typeof row['at'] === 'number' &&
    typeof row['text'] === 'string'
  );
}
