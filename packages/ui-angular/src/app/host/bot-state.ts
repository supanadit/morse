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
  BotUsage,
  ModelOption,
} from '@morse/protocol';

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
   * The counters each conversation's last answer reported, keyed by conversation.
   *
   * Bot mode has one engine session per bot, so this is whichever member spoke
   * last; the composer's ring draws it and says whose it is.
   */
  readonly usage = signal<Record<string, BotUsage>>({});
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
   * transcript would linger for a row that is gone — with the round and the
   * counters that described it, which is why all four go together.
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
    if (transcript.hasMore !== undefined) {
      this.hasOlder.update((held) => ({ ...held, [conversationId]: transcript.hasMore === true }));
    } else if (replace) {
      // A replace that does not say — a cleared conversation, or an older host —
      // must not keep the previous answer: offering "scroll up for earlier
      // messages" over a file that no longer exists invites a page of nothing.
      this.hasOlder.update((held) => ({ ...held, [conversationId]: false }));
    }
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
   * What one conversation's last answer cost. An id with no counters (a pruned
   * conversation) drops the ring rather than leaving the old number behind.
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
      if (!empty) {
        return { ...held, [usage.conversationId]: usage };
      }
      if (held[usage.conversationId] === undefined) {
        return held;
      }
      const next = { ...held };
      delete next[usage.conversationId];
      return next;
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
  }
}
