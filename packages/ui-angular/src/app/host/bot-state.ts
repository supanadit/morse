import { signal } from '@angular/core';
import type {
  BotConversationSummary,
  BotModelsMessage,
  BotRosterMessage,
  BotRoutingState,
  BotSummary,
  BotTranscriptEntry,
  BotTranscriptMessage,
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
  /** The round the host is running; `null` once none is in flight. */
  readonly routing = signal<BotRoutingState | null>(null);
  /** The models each `bot/probeModels` request answered with, keyed by its id. */
  readonly models = signal<Record<string, ModelOption[]>>({});

  /**
   * A pushed roster replaces the old one whole — it is always the full list.
   *
   * The conversation in front is checked against it: a roster push that no longer
   * lists it means the host dropped it (a deleted bot, and the DM it kept), so
   * the workspace stops pointing at it. Leaving `activeId` behind would let the
   * composer send a prompt to a conversation that no longer exists, and the held
   * transcript would linger for a row that is gone.
   */
  onRoster(roster: BotRosterMessage['payload']): void {
    const conversations = [...roster.conversations];
    this.roster.set({ bots: [...roster.bots], conversations });
    const active = this.activeId();
    if (active === null || conversations.some((conversation) => conversation.id === active)) {
      return;
    }
    this.activeId.set(null);
    this.routing.set(null);
    this.transcripts.update((held) => {
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
    const { conversationId, entries, replace } = transcript;
    this.transcripts.update((held) => {
      const current = replace ? [] : (held[conversationId] ?? []);
      return { ...held, [conversationId]: [...current, ...entries] };
    });
  }

  /** Who the host is asking right now, and whom it queued behind them. */
  onRouting(state: BotRoutingState | null): void {
    this.routing.set(state);
  }

  /** The models an engine offers with the wizard's credentials, for one request. */
  onModels(answer: BotModelsMessage['payload']): void {
    this.models.update((held) => ({ ...held, [answer.requestId]: answer.models }));
  }

  /**
   * Points the workspace at one conversation. The previous round belongs to the
   * conversation it started in, so the routing strip never shows over another.
   */
  open(id: string): void {
    this.activeId.set(id);
    this.routing.set(null);
  }

  /** Drops a conversation's lines, keeping the key so it reads as opened-but-empty. */
  resetTranscript(id: string): void {
    this.transcripts.update((held) => ({ ...held, [id]: [] }));
  }
}
