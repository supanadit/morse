import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BotDelivery,
  BotDeliveryKind,
  BotDeliveryReason,
  BotDeliveryStatus,
} from '@morse/protocol';
import { writeJsonAtomic } from './store.js';

/**
 * A delivery's day, both ways: finished work stays on disk this long as history,
 * and a `queued` ask that waits longer than this is dropped as undelivered. One
 * constant because the store keeps one file per conversation and a reader asks a
 * single question of it — what happened in the last day.
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
 * The directory is this store's own: the sweeps read every `*.json` in it as a
 * conversation queue, so it must not be shared with the registry or any other
 * JSON.
 *
 * A row only moves forward, and a terminal row never changes again. A queued row
 * may be dropped or cancelled without ever running (a full queue, a withdrawn
 * ask), but no terminal row can come back to be run twice. That is what lets a
 * lane read the file without a lock.
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
    const failures: string[] = [];
    for (const conversationId of this.conversations()) {
      // One unreadable file must not stop the rest from being repaired: at boot
      // this is the pass that unsticks work a crash left running, and refusing
      // to run it for every conversation because one is corrupt is worse than
      // finishing the sweep and reporting that one file. The failure is still
      // loud — it is collected here and thrown once the loop is done.
      try {
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
      } catch (error) {
        failures.push(this.describeFailure(conversationId, error));
      }
    }
    failIfAny('re-queue running deliveries', failures);
  }

  /**
   * Drops finished work older than `ttlMs`.
   *
   * Only terminal rows are candidates here. The undelivered TTL is the service's
   * job, not this sweep's: a `queued` row past its day must become `dropped` with
   * a transcript note (`BotService.dropExpiredDeliveries`), which runs after this
   * sweep precisely so the dropped row stays visible until the next sweep instead
   * of being deleted in the same pass. A `running` row is never dropped — the turn
   * timeout owns it, and removing it here would strand the engine session using
   * it.
   */
  prune(now: number, ttlMs: number): void {
    const cutoff = now - ttlMs;
    const failures: string[] = [];
    for (const conversationId of this.conversations()) {
      // As in `requeueRunning`: a broken file is reported, not allowed to stop
      // the other conversations from being pruned.
      try {
        const rows = this.read(conversationId);
        const kept = rows.filter((row) => !isTerminal(row.status) || row.createdAt >= cutoff);
        if (kept.length !== rows.length) {
          this.write(conversationId, kept);
        }
      } catch (error) {
        failures.push(this.describeFailure(conversationId, error));
      }
    }
    failIfAny('prune deliveries', failures);
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

  /** A sweep failure, named by the file it could not handle. */
  private describeFailure(conversationId: string, error: unknown): string {
    return `${this.filePath(conversationId)}: ${(error as Error).message}`;
  }

  /** Where a queue would live, even when its id is too unsafe to read. */
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
 * How far a delivery may move. Two terminal statuses are reachable straight from
 * `queued`: `cancelled` when a reader withdraws the work, and `dropped` when a
 * backstop refuses it before it ever ran — a full per-bot queue or a delivery
 * that sat undelivered past the TTL. Neither needs a running turn first, and
 * calling it "cancelled" would put the wrong word in the transcript. The four
 * terminal statuses go nowhere, which is the invariant every reader relies on.
 */
const NEXT_STATUS: Record<BotDeliveryStatus, readonly BotDeliveryStatus[]> = {
  queued: ['running', 'dropped', 'cancelled'],
  running: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  dropped: [],
  cancelled: [],
};

function isTerminal(status: BotDeliveryStatus): boolean {
  return NEXT_STATUS[status].length === 0;
}

const KINDS: readonly BotDeliveryKind[] = ['message', 'assign', 'reply'];
const REASONS: readonly BotDeliveryReason[] = [
  'mention',
  'all',
  'lead',
  'direct',
  'bot',
  'trigger',
];

/**
 * Reports every file a sweep could not handle, after the sweep has finished.
 * Failing loudly is deliberate — a corrupt queue must be repaired, not ignored —
 * but it must not be all-or-nothing: one bad file should not leave the other
 * conversations' work stuck running or unpruned.
 */
function failIfAny(action: string, failures: string[]): void {
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    `Cannot ${action}: ${failures.length} delivery file(s) failed — ${failures.join(' | ')}`,
  );
}

/**
 * The minimum a stored row must carry for a lane to use it. Deliberately not a
 * full schema — the sender's details and the text are elsewhere — but a `null`
 * or a missing required field would fail later inside a turn, so the file is
 * refused at read with its path instead. `depth` and `kind`/`reason` are checked
 * because a row without them still type-checks as a delivery: an absent `depth`
 * would make the bot-to-bot cap compare against `undefined` and quietly stop
 * capping.
 */
function isDelivery(value: unknown): value is BotDelivery {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  const from = row['from'] as Record<string, unknown> | undefined;
  return (
    typeof row['id'] === 'string' &&
    typeof row['rootId'] === 'string' &&
    typeof row['conversationId'] === 'string' &&
    typeof row['entryId'] === 'string' &&
    typeof row['to'] === 'string' &&
    typeof row['depth'] === 'number' &&
    typeof row['createdAt'] === 'number' &&
    typeof row['status'] === 'string' &&
    Object.hasOwn(NEXT_STATUS, row['status']) &&
    KINDS.includes(row['kind'] as BotDeliveryKind) &&
    REASONS.includes(row['reason'] as BotDeliveryReason) &&
    typeof from === 'object' &&
    from !== null &&
    typeof from['type'] === 'string'
  );
}
