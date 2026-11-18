import { signal } from '@angular/core';
import type {
  BotConfig,
  BotConversationSummary,
  BotModelsMessage,
  BotRosterMessage,
  BotRoutingMessage,
  BotRoutingState,
  BotSummary,
  BotTranscriptEntry,
  BotTranscriptMessage,
  BotTurnTrace,
  BotUsage,
  ModelOption,
} from '@morse/protocol';

/**
 * One conversation's finished turns, oldest first and one row per id: a page
 * replaces, an older page prepends and a settled turn appends, so the same turn
 * arriving twice — a resend, or a page that overlaps what is held — stays one.
 */
function mergeTraces(current: BotTurnTrace[], incoming: BotTurnTrace[]): BotTurnTrace[] {
  const byId = new Map<string, BotTurnTrace>();
  for (const trace of current) {
    byId.set(trace.id, trace);
  }
  for (const trace of incoming) {
    byId.set(trace.id, trace);
  }
  return [...byId.values()].sort((left, right) => left.endedAt - right.endedAt);
}

/** The roster as one value: the bots the host runs, and the conversations it keeps. */
export interface BotRoster {
  bots: BotSummary[];
  conversations: BotConversationSummary[];
}

/**
 * Bot mode's client-side state: the roster, the conversation in front, the
 * transcript held for each conversation, the round in flight, and the model
 * answers the New bot wizard probes for.
 *
 * Frontend state, not wire state: `SessionView` stays the code-mode view, and
 * `MorseService` folds the four `bot/*` host messages here. The transcript is
 * held per conversation so switching back and forth while the host streams a
 * reply never loses lines.
 *
 * It lives beside the seam (not under `state/`) for the same reason `SessionView`
 * does: the seam is what fills it, and `host/` may import no layer above it
 * (R-U6). A plain class rather than an Angular service because exactly one owner
 * exists — `MorseService` injects nothing to hold it.
 */
export class BotState {
  readonly roster = signal<BotRoster | null>(null);
  /** The conversation the bot workspace shows; `null` before the first open. */
  readonly activeId = signal<string | null>(null);
  readonly transcripts = signal<Record<string, BotTranscriptEntry[]>>({});
  /**
   * Every settled turn held per conversation, oldest first.
   *
   * A trace is the record of a turn that already ended, so it is kept beside the
   * lines rather than appended to them: opening a conversation brings a window of
   * both, and a settle push adds one turn without touching the transcript.
   */
  readonly traces = signal<Record<string, BotTurnTrace[]>>({});
  /**
   * Whether older entries remain before what is held, per conversation. The chat
   * asks for another page when the reader scrolls to the top and this is true.
   */
  readonly hasOlder = signal<Record<string, boolean>>({});
  /**
   * Every round in flight, keyed by conversation.
   *
   * A map rather than one value because rounds are per conversation: two bots can
   * be answering in two rooms at once, and switching between them must neither
   * hide the presence row of the one still working nor invent one for a room that
   * is idle. `bot/routing` names its conversation on the way in — including when
   * it clears — so a round ending in another room leaves this one alone.
   */
  readonly routing = signal<Record<string, BotRoutingState>>({});
  /**
   * The counters each bot in a conversation last reported, per conversation and
   * then per bot, oldest report first.
   *
   * Bot mode has one engine session per bot, so usage is per `(conversation, bot)`
   * and a room can hold two windows at once. The composer's single ring reads the
   * last entry (the bot that reported most recently); a presence row reads its own
   * bot's, which is why this is keyed rather than one value per conversation.
   */
  readonly usage = signal<Record<string, BotUsage[]>>({});
  /** The models each `bot/probeModels` request answered with, keyed by its id. */
  readonly models = signal<Record<string, ModelOption[]>>({});
  /**
   * The bot record Edit bot asked for, by name. Kept until another bot is
   * inspected, so reopening the same bot's form does not flash empty fields.
   */
  readonly configs = signal<Record<string, BotConfig>>({});

  /**
   * A pushed roster replaces the old one whole — it is always the full list.
   *
   * The conversation in front is checked against it: a roster push that no longer
   * lists it means the host dropped it (a deleted bot, and the DM it kept), so
   * the workspace stops pointing at it. Leaving `activeId` behind would let the
   * composer send a prompt to a conversation that no longer exists, and the held
   * transcript would linger for a row that is gone — with the record of the turns
   * that produced it, the round and the counters that described it, which is why
   * they all go together.
   */
  onRoster(roster: BotRosterMessage['payload']): void {
    const conversations = [...roster.conversations];
    this.roster.set({ bots: [...roster.bots], conversations });
    const active = this.activeId();
    if (active === null || conversations.some((conversation) => conversation.id === active)) {
      return;
    }
    this.activeId.set(null);
    this.transcripts.update((held) => {
      if (held[active] === undefined) {
        return held;
      }
      const next = { ...held };
      delete next[active];
      return next;
    });
    this.hasOlder.update((held) => {
      const next = { ...held };
      delete next[active];
      return next;
    });
    this.traces.update((held) => {
      if (held[active] === undefined) {
        return held;
      }
      const next = { ...held };
      delete next[active];
      return next;
    });
    this.routing.update((held) => {
      if (held[active] === undefined) {
        return held;
      }
      const next = { ...held };
      delete next[active];
      return next;
    });
    this.usage.update((held) => {
      if (held[active] === undefined) {
        return held;
      }
      const next = { ...held };
      delete next[active];
      return next;
    });
  }

  /**
   * Transcript lines as the host now has them. `replace` resets what is held
   * (opening a conversation); entries alone are the lines a round appended since.
   */
  onTranscript(transcript: BotTranscriptMessage['payload']): void {
    const { conversationId, entries, replace, prepend } = transcript;
    this.transcripts.update((held) => {
      const current = replace ? [] : (held[conversationId] ?? []);
      // A page fetched by scrolling up goes in front; everything else is new.
      return {
        ...held,
        [conversationId]: prepend === true ? [...entries, ...current] : [...current, ...entries],
      };
    });
    const incoming = transcript.traces;
    if (replace) {
      // A page is the newest window. No traces on it means no turn settled there,
      // which is what a fresh or cleared room sends: what was held is not part of
      // this window, so the record starts from what the host just said.
      this.traces.update((held) => ({
        ...held,
        [conversationId]: mergeTraces([], incoming ?? []),
      }));
    } else if (incoming !== undefined && incoming.length > 0) {
      this.traces.update((held) => {
        const current = held[conversationId] ?? [];
        return {
          ...held,
          [conversationId]:
            prepend === true ? mergeTraces(incoming, current) : mergeTraces(current, incoming),
        };
      });
    }
    if (transcript.hasMore !== undefined) {
      this.hasOlder.update((held) => ({ ...held, [conversationId]: transcript.hasMore === true }));
    } else if (replace) {
      // A replace that does not say — a cleared conversation, or an older host —
      // must not keep the previous answer: offering "scroll up for earlier
      // messages" over a file that no longer exists invites a page of nothing.
      this.hasOlder.update((held) => ({ ...held, [conversationId]: false }));
    }
  }

  /** The finished turns held for one conversation, oldest first. */
  tracesFor(conversationId: string): BotTurnTrace[] {
    return this.traces()[conversationId] ?? [];
  }

  /**
   * Who the host is asking in one conversation, and whom it queued behind them.
   *
   * `state: null` ends that conversation's row only. Anything else replaces it
   * whole: the host always sends the round as it now stands.
   */
  onRouting(routing: BotRoutingMessage['payload']): void {
    const { conversationId, state } = routing;
    this.routing.update((held) => {
      if (state === null) {
        if (held[conversationId] === undefined) {
          return held;
        }
        const next = { ...held };
        delete next[conversationId];
        return next;
      }
      return { ...held, [conversationId]: state };
    });
  }

  /**
   * What one bot in one conversation last reported, or `undefined` when it has
   * not answered there. This is what a presence row's own ring draws.
   */
  usageFor(conversationId: string, username: string): BotUsage | undefined {
    return this.usage()[conversationId]?.find((one) => one.username === username);
  }

  /**
   * The most recently reported bot in one conversation, for the composer's single
   * ring: the session the reader just watched work, named by what it reports.
   */
  latestUsage(conversationId: string): BotUsage | undefined {
    return this.usage()[conversationId]?.at(-1);
  }

  /**
   * One bot's counters, as the host reported them.
   *
   * A payload with no counters is a prune — the engine session is gone — and drops
   * that bot alone; the room's entry goes when its last bot does. A report for a
   * bot already held moves it to the end, so `latestUsage` means "reported most
   * recently" rather than "first seen".
   */
  onUsage(usage: BotUsage): void {
    this.usage.update((held) => {
      const empty =
        usage.usage === undefined &&
        usage.lastUsage === undefined &&
        usage.contextUsage === undefined &&
        usage.counts === undefined &&
        usage.speed === undefined &&
        usage.costUsd === undefined;
      const others = (held[usage.conversationId] ?? []).filter(
        (one) => one.username !== usage.username,
      );
      const next = empty ? others : [...others, usage];
      if (next.length === 0) {
        if (held[usage.conversationId] === undefined) {
          return held;
        }
        const rooms = { ...held };
        delete rooms[usage.conversationId];
        return rooms;
      }
      return { ...held, [usage.conversationId]: next };
    });
  }

  /** The models an engine offers with the wizard's credentials, for one request. */
  onModels(answer: BotModelsMessage['payload']): void {
    this.models.update((held) => ({ ...held, [answer.requestId]: answer.models }));
  }

  /** One bot's own record, as the host answered an inspect, keyed by handle. */
  onConfig(config: BotConfig): void {
    this.configs.update((held) => ({ ...held, [config.username]: config }));
  }

  /**
   * Points the workspace at one conversation.
   *
   * A round belongs to the conversation it started in, so nothing about the room
   * being left is touched: the row for a bot still working stays in `routing` and
   * is there again when the reader comes back.
   */
  open(id: string): void {
    this.activeId.set(id);
  }

  /** The round in flight in one conversation, if any. */
  routingFor(id: string): BotRoutingState | undefined {
    return this.routing()[id];
  }

  /** Drops a conversation's lines, keeping the key so it reads as opened-but-empty. */
  resetTranscript(id: string): void {
    this.transcripts.update((held) => ({ ...held, [id]: [] }));
    this.traces.update((held) => ({ ...held, [id]: [] }));
  }
}
