/**
 * The turn a bot is taking, kept while it runs.
 *
 * A reader watching a room is shown a live row: the work in progress, the asks
 * it handed out and the answer as it is written. None of that is history — it
 * exists only until the turn settles, then the row is dropped. Keeping the
 * record here, with no I/O, means its shape can be read and tested without a
 * service or a file.
 *
 * One record per bot handle: lanes are per bot, so a bot takes one turn at a
 * time and starting another replaces whatever the record held.
 */

import type { BotActivity, BotHandoff } from '@morse/protocol';
import { startingActivity } from './activity.js';

/** How many steps a turn carries: enough for the row's detail, cheap to push. */
export const TURN_STEPS_MAX = 8;
/** How many asks a turn carries on its row. */
export const TURN_HANDOFFS_MAX = 8;
/** How much of the answer travels with the row: its tail, not its beginning. */
export const TURN_PARTIAL_MAX = 2_000;
/** How much of a failed tool's output the step keeps for the row to open. */
export const TURN_ERROR_MAX = 300;

/** One turn as its readers see it. */
export interface TurnSnapshot {
  /** The bot answering, by handle: the one key a record has. */
  username: string;
  /** The thread or room the answer belongs to. */
  conversationId: string;
  /** Epoch milliseconds the turn was taken off the queue. */
  startedAt: number;
  /** Every step taken so far, newest last and capped at `TURN_STEPS_MAX`. */
  steps: BotActivity[];
  /** The asks this turn handed to other bots, oldest first. */
  handoffs: BotHandoff[];
  /** The answer so far, text channel only; empty until the bot writes a word. */
  partial: string;
}

/** One turn as the tracker keeps it: the snapshot plus what only it needs. */
interface TurnRecord {
  username: string;
  conversationId: string;
  startedAt: number;
  steps: BotActivity[];
  /**
   * The step each live tool call opened, by the engine's own call id. A step
   * that falls off the turn takes its entry with it, so a late update finds
   * nothing to close rather than a different call's row.
   */
  toolSteps: Map<string, BotActivity>;
  handoffs: BotHandoff[];
  partial: string;
}

/**
 * The turns bots are taking right now, one per handle.
 *
 * Every method is a no-op for a username with no record: the service starts a
 * turn before it reports anything, and an event that arrives after the settle
 * belongs to a turn that is already history.
 */
export class BotTurnTracker {
  private readonly clock: () => number;
  private readonly turns = new Map<string, TurnRecord>();

  constructor(clock: () => number) {
    this.clock = clock;
  }

  /** Opens a turn for a bot, replacing whatever its previous turn left behind. */
  start(username: string, conversationId: string): void {
    const startedAt = this.clock();
    this.turns.set(username, {
      username,
      conversationId,
      startedAt,
      steps: [startingActivity(startedAt)],
      toolSteps: new Map(),
      handoffs: [],
      partial: '',
    });
  }

  /** The turn a bot is taking, or nothing when it is not taking one. */
  get(username: string): TurnSnapshot | undefined {
    const turn = this.turns.get(username);
    return turn === undefined ? undefined : snapshotOf(turn);
  }

  /**
   * Adds a step, newest last: the last step is the row's current line.
   * `toolCallId` ties the step to the call that opened it, so `toolStatus` can
   * close it later.
   */
  step(username: string, step: BotActivity, toolCallId?: string): void {
    const turn = this.turns.get(username);
    if (turn === undefined) {
      return;
    }
    turn.steps.push(step);
    if (toolCallId !== undefined) {
      turn.toolSteps.set(toolCallId, step);
    }
    trimSteps(turn);
  }

  /**
   * Moves the newest step to a new time without adding one: a thought or a
   * written word that repeats is the same line continuing, not another line, so
   * a turn keeps the history it took instead of losing it to a token stream. A
   * bot with no record, or a record with no step, is left alone.
   */
  touch(username: string, at: number): void {
    const step = this.turns.get(username)?.steps.at(-1);
    if (step === undefined) {
      return;
    }
    step.at = at;
  }

  /** Moves the step a tool call opened, while that step is still on the turn. */
  toolStatus(
    username: string,
    toolCallId: string,
    update: { status: 'running' | 'ok' | 'error'; error?: string; durationMs?: number },
  ): void {
    const target = this.turns.get(username)?.toolSteps.get(toolCallId);
    if (target === undefined) {
      return;
    }
    target.status = update.status;
    if (update.error !== undefined) {
      // The row opens this text, so it becomes one line here rather than in
      // every reader that draws it.
      target.error = errorLine(update.error);
    }
    if (update.durationMs !== undefined) {
      target.durationMs = update.durationMs;
    }
  }

  /** Appends what the bot wrote, keeping the tail a row can show. */
  appendPartial(username: string, delta: string): void {
    const turn = this.turns.get(username);
    if (turn === undefined) {
      return;
    }
    turn.partial = (turn.partial + delta).slice(-TURN_PARTIAL_MAX);
  }

  /**
   * Records an ask this turn made. A delivery already on the row is replaced in
   * place: the delivery is the ask's identity, and its state moves with it.
   */
  handoff(username: string, handoff: BotHandoff): void {
    const turn = this.turns.get(username);
    if (turn === undefined) {
      return;
    }
    const at = turn.handoffs.findIndex((one) => one.deliveryId === handoff.deliveryId);
    if (at !== -1) {
      turn.handoffs[at] = handoff;
      return;
    }
    turn.handoffs.push(handoff);
    if (turn.handoffs.length > TURN_HANDOFFS_MAX) {
      turn.handoffs.splice(0, turn.handoffs.length - TURN_HANDOFFS_MAX);
    }
  }

  /** Drops a turn without keeping it. */
  clear(username: string): void {
    this.turns.delete(username);
  }
}

/**
 * One turn as readers see it: fresh arrays, so a reader cannot add or drop
 * entries. The step objects themselves are still the record's own.
 */
function snapshotOf(turn: TurnRecord): TurnSnapshot {
  return {
    username: turn.username,
    conversationId: turn.conversationId,
    startedAt: turn.startedAt,
    steps: [...turn.steps],
    handoffs: [...turn.handoffs],
    partial: turn.partial,
  };
}

/** Keeps the newest steps, and forgets the tool calls whose steps just left. */
function trimSteps(turn: TurnRecord): void {
  if (turn.steps.length <= TURN_STEPS_MAX) {
    return;
  }
  const dropped = turn.steps.splice(0, turn.steps.length - TURN_STEPS_MAX);
  for (const [toolCallId, step] of turn.toolSteps) {
    if (dropped.includes(step)) {
      turn.toolSteps.delete(toolCallId);
    }
  }
}

/**
 * A failed tool's output as the row keeps it: its first line, because a
 * traceback is a paragraph and the row has one line to open.
 */
function errorLine(error: string): string {
  const end = error.indexOf('\n');
  const line = end === -1 ? error : error.slice(0, end);
  // A line ending in CRLF keeps the CR before the split.
  const unbroken = line.endsWith('\r') ? line.slice(0, -1) : line;
  return unbroken.length > TURN_ERROR_MAX ? unbroken.slice(0, TURN_ERROR_MAX) : unbroken;
}
