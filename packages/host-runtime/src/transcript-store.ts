import type { AgentEvent, NoticeLevel } from '@morse/core';
import type { ChatPin, HostToClientMessage, PromptImage, TranscriptItem } from '@morse/protocol';
import { TranscriptProjector } from './transcript-projector.js';

export interface TranscriptUpdate {
  sessionKey: string;
  message: HostToClientMessage;
  /**
   * The transcript after this update, copied only when it is read. The controller
   * forwards `message` and never looks at the items, so copying every item on
   * every delta was garbage for nothing.
   */
  readonly items: TranscriptItem[];
}

/** How far back a session's transcript has been paged. */
export interface HistoryCursor {
  before?: string;
  hasOlder: boolean;
}

/**
 * Transcript per session, shared by every connection of a host.
 *
 * It sits next to the session registry because it has the same lifetime: the
 * agent process outlives a client, so its conversation must too. A controller
 * feeds agent events in and forwards the updates of whichever session it is
 * displaying — which is what makes a refresh (or a second window) keep the
 * transcript instead of starting from an empty panel.
 */
export class SessionTranscriptStore {
  private readonly projectors = new Map<string, TranscriptProjector>();
  private readonly cursors = new Map<string, HistoryCursor>();
  private readonly listeners = new Set<(update: TranscriptUpdate) => void>();

  subscribe(listener: (update: TranscriptUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  items(sessionKey: string): TranscriptItem[] {
    return this.projectors.get(sessionKey)?.snapshot() ?? [];
  }

  /**
   * Paging state lives with the transcript, not the connection: a refresh
   * reattaches to the same warm session and must keep offering older pages.
   */
  historyCursor(sessionKey: string): HistoryCursor {
    return this.cursors.get(sessionKey) ?? { hasOlder: false };
  }

  setHistoryCursor(sessionKey: string, cursor: HistoryCursor): void {
    this.cursors.set(sessionKey, cursor);
  }

  apply(sessionKey: string, event: AgentEvent): void {
    this.projectorFor(sessionKey).apply(event);
  }

  /** Replays a resumed session's history into an empty transcript. */
  seed(sessionKey: string, items: TranscriptItem[]): void {
    const projector = this.projectorFor(sessionKey);
    for (const item of items) {
      projector.append(item);
    }
  }

  /** Inserts an older history page in front of a session's transcript. */
  prepend(sessionKey: string, items: TranscriptItem[]): void {
    this.projectorFor(sessionKey).prepend(items);
  }

  /**
   * Moves a transcript to a new session key after the agent forked the session
   * before a past message. The caller passes the rows that survive the fork;
   * the branch after the edited message is dropped with a single replace, so no
   * stale rows linger under the new session.
   */
  move(fromKey: string, toKey: string, items: TranscriptItem[]): void {
    if (fromKey === toKey) {
      this.projectorFor(toKey).replace(items);
      return;
    }
    this.projectors.delete(fromKey);
    this.cursors.delete(fromKey);
    this.cursors.set(toKey, { hasOlder: false });
    this.projectorFor(toKey).replace(items);
  }

  userPrompt(sessionKey: string, text: string, images?: PromptImage[], pins?: ChatPin[]): void {
    this.projectorFor(sessionKey).userPrompt(text, images, pins);
  }

  notice(sessionKey: string, level: NoticeLevel, text: string): void {
    this.projectorFor(sessionKey).notice(level, text);
  }

  error(sessionKey: string, message: string, detail?: string): void {
    this.projectorFor(sessionKey).error(message, detail);
  }

  /** Drops a transcript (used when a session is closed or restarted). */
  reset(sessionKey: string): void {
    this.cursors.delete(sessionKey);
    const projector = this.projectors.get(sessionKey);
    if (!projector) {
      return;
    }
    projector.reset();
  }

  clear(sessionKey: string): void {
    this.cursors.delete(sessionKey);
    this.projectors.delete(sessionKey);
  }

  dispose(): void {
    this.projectors.clear();
    this.cursors.clear();
    this.listeners.clear();
  }

  private projectorFor(sessionKey: string): TranscriptProjector {
    let projector = this.projectors.get(sessionKey);
    if (!projector) {
      projector = new TranscriptProjector({
        emit: (message) => {
          this.emit({
            sessionKey,
            message,
            get items(): TranscriptItem[] {
              return projector?.snapshot() ?? [];
            },
          });
        },
      });
      this.projectors.set(sessionKey, projector);
    }
    return projector;
  }

  private emit(update: TranscriptUpdate): void {
    for (const listener of [...this.listeners]) {
      listener(update);
    }
  }
}
