import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BotDelivery, BotDeliveryStatus } from '@morse/protocol';
import { writeJsonAtomic } from './store.js';

/**
 * How long a finished delivery stays on disk: one day of history per
 * conversation, enough for a reader's view to still explain what happened
 * without letting the queue grow forever.
 */
export const DELIVERY_TTL_MS = 86_400_000;

/**
 * Bot conversations' delivery queues, kept on disk so a restart does not lose
 * work that was already handed over.
 *
 * One JSON array per conversation at `<dir>/<conversationId>.json`: a DM's id and
 * a group's id are both stable, directory-safe and unique, so the file name is
 * the key. The whole array is rewritten on every change because a delivery's
 * status changes in place and a lane reads the queue as one ordered list; the
 * write is atomic, so a crash leaves the previous queue intact.
 *
 * A row only moves forward — queued, then running, then one terminal status —
 * and a terminal row never changes again. That is what lets a lane read the file
 * without a lock: work that is `done` cannot come back to be run twice.
 */
export class BotDeliveryStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Every delivery in a conversation, oldest first. A missing file is a
   * conversation with no work yet, not an error: it reads as an empty queue.
   * A present-but-malformed file throws instead, so a broken queue is never
   * mistaken for an empty one and then overwritten by the next add.
   */
  all(conversationId: string): BotDelivery[] {
    return this.read(conversationId);
  }

  /** The work waiting for one bot, in the order it was queued. */
  queued(conversationId: string, to: string): BotDelivery[] {
    return this.read(conversationId).filter((row) => row.to === to && row.status === 'queued');
  }

  /**
   * Queues one delivery. An id that is already stored replaces its row in place
   * rather than being appended beside it: every reader treats the id as the
   * identity of the work, so a duplicate would be two rows for one turn.
   */
  add(delivery: BotDelivery): void {
    const rows = this.read(delivery.conversationId);
    const at = rows.findIndex((row) => row.id === delivery.id);
    if (at === -1) {
      rows.push(delivery);
    } else {
      rows[at] = delivery;
    }
    this.write(delivery.conversationId, rows);
  }

  /**
   * Moves one delivery forward. A terminal status is final, so a late "failed"
   * cannot overwrite a "done" a lane already reported; an unknown id is ignored
   * rather than failing a lane whose row was pruned underneath it. A `note`
   * replaces the stored one only when it is passed, so a status change that has
   * nothing to add leaves the explanation in place.
   */
  setStatus(conversationId: string, id: string, status: BotDeliveryStatus, note?: string): void {
    const rows = this.read(conversationId);
    const row = rows.find((one) => one.id === id);
    if (row === undefined || !NEXT_STATUS[row.status].includes(status)) {
      return;
    }
    row.status = status;
    if (note !== undefined) {
      row.note = note;
    }
    this.write(conversationId, rows);
  }

  /**
   * Puts every `running` delivery back in the queue. A lane marks a delivery
   * running before it starts a turn, so anything still running at boot belonged
   * to a process that died; without this it would sit running forever and the
   * bot would never see the work. This is the one place a status moves back.
   */
  requeueRunning(): void {
    for (const conversationId of this.conversations()) {
      const rows = this.read(conversationId);
      let changed = false;
      for (const row of rows) {
        if (row.status === 'running') {
          row.status = 'queued';
          changed = true;
        }
      }
      if (changed) {
        this.write(conversationId, rows);
      }
    }
  }

  /**
   * Drops finished work older than `ttlMs`. Only terminal rows are candidates:
   * a queued or running delivery is still owed a turn, however old it is, so
   * pruning it would lose work rather than history.
   */
  prune(now: number, ttlMs: number): void {
    const cutoff = now - ttlMs;
    for (const conversationId of this.conversations()) {
      const rows = this.read(conversationId);
      const kept = rows.filter((row) => !isTerminal(row.status) || row.createdAt >= cutoff);
      if (kept.length !== rows.length) {
        this.write(conversationId, kept);
      }
    }
  }

  /** Removes a conversation's queue, for a conversation that no longer exists. */
  forget(conversationId: string): void {
    rmSync(this.pathFor(conversationId), { force: true });
  }

  /** Every conversation this store holds a queue for. */
  private conversations(): string[] {
    if (!existsSync(this.dir)) {
      return [];
    }
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  }

  private pathFor(conversationId: string): string {
    // The id comes from Morse's own registry (a DM's username or a generated
    // group id), but it is still validated here: this value becomes a path.
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_-]*$/.test(conversationId)) {
      throw new Error(`"${conversationId}" is not a usable conversation id.`);
    }
    return join(this.dir, `${conversationId}.json`);
  }

  private read(conversationId: string): BotDelivery[] {
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
    if (!Array.isArray(parsed) || !parsed.every(isDelivery)) {
      throw new Error(`Cannot read ${path}: expected a list of bot deliveries.`);
    }
    return parsed;
  }

  private write(conversationId: string, rows: BotDelivery[]): void {
    writeJsonAtomic(this.pathFor(conversationId), rows);
  }
}

/**
 * How far a delivery may move. `queued → cancelled` is the one shortcut: a
 * reader who withdraws work before a lane picks it up does not need it to run
 * first to be cancelled. The four terminal statuses go nowhere, which is the
 * invariant every reader relies on.
 */
const NEXT_STATUS: Record<BotDeliveryStatus, readonly BotDeliveryStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['done', 'failed', 'dropped', 'cancelled'],
  done: [],
  failed: [],
  dropped: [],
  cancelled: [],
};

function isTerminal(status: BotDeliveryStatus): boolean {
  return NEXT_STATUS[status].length === 0;
}

/**
 * The minimum a stored row must carry for a lane to use it. Deliberately not a
 * full schema — `entryId` and the sender are the service's business — but a
 * `null` or a number in the array would fail later inside a turn, so the file is
 * refused at read with its path instead.
 */
function isDelivery(value: unknown): value is BotDelivery {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  const from = row['from'] as Record<string, unknown> | undefined;
  return (
    typeof row['id'] === 'string' &&
    typeof row['conversationId'] === 'string' &&
    typeof row['entryId'] === 'string' &&
    typeof row['to'] === 'string' &&
    typeof row['createdAt'] === 'number' &&
    typeof row['status'] === 'string' &&
    Object.hasOwn(NEXT_STATUS, row['status']) &&
    typeof from === 'object' &&
    from !== null &&
    typeof from['type'] === 'string'
  );
}
