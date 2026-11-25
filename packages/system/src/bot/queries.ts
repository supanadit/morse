/**
 * Bot mode's read side: transcripts, the turns beside them, the routing state a
 * room draws, and the counters each bot reported. Reads only — writes stay in
 * `BotService` so the delivery/lane state has one owner.
 */
import type {
  BotDelivery,
  BotHandoff,
  BotRoutingActive,
  BotRoutingState,
  BotTranscriptEntry,
  BotUsage,
  BotWaitingAsk,
} from '@morse/protocol';
import type { MorseLogger } from '../logger.js';
import { startingActivity } from './activity.js';
import type { BotDeliveryStore } from './deliveries.js';
import { handoffState } from './helpers.js';
import {
  TRANSCRIPT_PAGE_SIZE,
  type BotTranscriptStore,
  type TranscriptSlice,
} from './transcripts.js';
import type { BotTurnTracker } from './turns.js';
import type { BotRegistryFile } from './types.js';

export interface BotQueriesDeps {
  transcripts: BotTranscriptStore;
  deliveries: BotDeliveryStore;
  registry: () => BotRegistryFile;
  turns: BotTurnTracker;
  usageByBot: Map<string, BotUsage>;
  logger: MorseLogger;
  displayNameOf: (username: string) => string;
}

export class BotQueries {
  constructor(private readonly deps: BotQueriesDeps) {}

  /** The whole conversation, oldest first. A read: an unknown id is simply empty. */
  transcript(conversationId: string): BotTranscriptEntry[] {
    return this.deps.transcripts.all(conversationId);
  }

  /**
   * The newest page, which is what opening a conversation shows. `hasMore` tells
   * the chat whether scrolling up has anything to fetch.
   */
  open(conversationId: string, limit: number = TRANSCRIPT_PAGE_SIZE): TranscriptSlice {
    return this.deps.transcripts.latest(conversationId, limit);
  }

  /** The page before `beforeId`, for the chat's scroll-to-top. */
  history(
    conversationId: string,
    beforeId: string | undefined,
    limit: number = TRANSCRIPT_PAGE_SIZE,
  ): TranscriptSlice {
    return this.deps.transcripts.before(conversationId, beforeId, limit);
  }

  /**
   * The work in flight on one conversation, as the chat draws it, or `null`.
   *
   * Read by the host when a conversation opens: a client that arrives — or
   * returns — mid-turn must see every bot still working, since the service only
   * pushes a state when it changes. Built from the delivery file plus the live
   * turn records, so the answer to an opening read and a push cannot disagree.
   */
  routing(conversationId: string): BotRoutingState | null {
    return this.routingFrom(conversationId, this.deps.deliveries.all(conversationId));
  }

  /** One room's state, from rows the caller already read. */
  routingFrom(conversationId: string, rows: BotDelivery[]): BotRoutingState | null {
    // A row's asks point at deliveries in other rooms (the thread a bot opened),
    // so each room is read once per push however many asks point into it.
    const byRoom = new Map<string, BotDelivery[]>([[conversationId, rows]]);
    const rowsOf = (id: string): BotDelivery[] => {
      const cached = byRoom.get(id);
      if (cached !== undefined) {
        return cached;
      }
      const read = this.deps.deliveries.all(id);
      byRoom.set(id, read);
      return read;
    };
    const active = rows
      .filter((row) => row.status === 'running')
      .map((row) => this.activeRow(row, rowsOf));
    const queued = rows
      .filter((row) => row.status === 'queued')
      .map((row) => this.deps.displayNameOf(row.to));
    const waiting = this.waitingAsks(conversationId);
    if (active.length === 0 && queued.length === 0 && waiting.length === 0) {
      return null;
    }
    return {
      conversationId,
      active,
      queued,
      ...(waiting.length === 0 ? {} : { waiting }),
    };
  }

  /**
   * The asks this room's bots have made elsewhere and not been answered on.
   *
   * A peer works in its own thread, so nothing in this room moves while it does.
   * The rows come from the delivery files — the ask names the room it was made
   * from — which is what lets a client that opens the room late and one watching
   * a push draw the same list. Only threads are read: an ask to a bot already in
   * this room is visible here, answering, and needs no row of its own.
   */
  private waitingAsks(roomId: string): BotWaitingAsk[] {
    const asks: BotWaitingAsk[] = [];
    for (const conversation of this.deps.registry().conversations) {
      if (conversation.id === roomId || conversation.kind !== 'thread') {
        continue;
      }
      let rows: BotDelivery[];
      try {
        rows = this.deps.deliveries.all(conversation.id);
      } catch (error: unknown) {
        // One unreadable queue must not cost the room its presence: the wait it
        // holds is unknown, not the whole row. It is reported like every other
        // broken file, and the next push tries again.
        this.deps.logger.warn(`Failed to read the deliveries in "${conversation.id}"`, error);
        continue;
      }
      for (const row of rows) {
        if (row.originId !== roomId || (row.status !== 'queued' && row.status !== 'running')) {
          continue;
        }
        const turn = this.deps.turns.get(row.to);
        const activity =
          turn !== undefined && turn.conversationId === conversation.id ? turn.steps.at(-1) : undefined;
        asks.push({
          username: row.to,
          target: this.deps.displayNameOf(row.to),
          conversationId: conversation.id,
          deliveryId: row.id,
          state: row.status === 'running' ? 'working' : 'asked',
          at: row.createdAt,
          ...(activity === undefined ? {} : { activity }),
        });
      }
    }
    // Insertion order breaks a same-millisecond tie, so two asks never swap.
    return asks.sort((left, right) => left.at - right.at);
  }

  /**
   * One running delivery as the row draws it: the turn record when the lane has
   * one, and a one-step starting row when a delivery was re-queued and no
   * record survived. `activity` is always the newest step, so a row cannot show a
   * line its own step list does not carry.
   */
  private activeRow(
    row: BotDelivery,
    rowsOf: (conversationId: string) => BotDelivery[],
  ): BotRoutingActive {
    const turn = this.deps.turns.get(row.to);
    const record =
      turn !== undefined && turn.conversationId === row.conversationId ? turn : undefined;
    const startedAt = record?.startedAt ?? row.createdAt;
    const steps = record?.steps ?? [startingActivity(startedAt)];
    return {
      target: this.deps.displayNameOf(row.to),
      username: row.to,
      activity: steps.at(-1) ?? startingActivity(startedAt),
      startedAt,
      steps,
      handoffs: (record?.handoffs ?? []).map((handoff) => this.handoffRow(handoff, rowsOf)),
      ...(record === undefined || record.partial === '' ? {} : { partial: record.partial }),
    };
  }

  /**
   * One ask as its sender's row draws it: its state read from the delivery it
   * created, so it moves asked → working → done without the sender's engine
   * saying anything else, and the peer's live step when its turn is in that room.
   */
  private handoffRow(
    handoff: BotHandoff,
    rowsOf: (conversationId: string) => BotDelivery[],
  ): BotHandoff {
    const delivery = rowsOf(handoff.conversationId).find((row) => row.id === handoff.deliveryId);
    const target = this.deps.turns.get(handoff.username);
    const activity =
      target !== undefined && target.conversationId === handoff.conversationId
        ? target.steps.at(-1)
        : undefined;
    return {
      ...handoff,
      ...(delivery === undefined ? {} : { state: handoffState(delivery.status) }),
      ...(activity === undefined ? {} : { activity }),
    };
  }

  /**
   * The counters each bot in one conversation last reported, oldest report first,
   * or an empty list before anyone answers. A read: an unknown conversation is
   * simply empty.
   *
   * Keyed per `(conversation, bot)` because a lane is per bot: a room can have two
   * engine sessions with two windows, and reporting only the last answer would
   * leave the other bot's ring describing nothing.
   */
  usages(conversationId: string): BotUsage[] {
    return [...this.deps.usageByBot.values()].filter(
      (usage) => usage.conversationId === conversationId,
    );
  }
}
