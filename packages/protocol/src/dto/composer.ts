import type { ChatPin, PromptImage } from './transcript.js';

/** Why a shared session's queue stopped draining. */
export type ComposerPauseReason = 'stopped' | 'failed';

/**
 * One follow-up waiting in the host-owned queue.
 *
 * The host assigns `id`, so every client edits the same item. `text` is what the
 * composer showed; `images` and `pins` are the attachments it carried, stored
 * with the item so editing or reordering cannot lose them.
 */
export interface SharedComposerPrompt {
  id: string;
  text: string;
  images?: PromptImage[];
  pins?: ChatPin[];
  /** Set when the item is a scheduled compaction rather than a message. */
  compaction?: { instructions?: string };
}

/**
 * A session's queue and pause state, as the host holds it.
 *
 * The pause is absent while the queue drains normally. It is set only when a
 * turn the reader stopped, or one that failed, left items waiting — a natural
 * finish keeps draining. Every connected client sees the same state.
 */
export interface SharedComposerState {
  sessionId: string;
  queue: SharedComposerPrompt[];
  paused?: ComposerPauseReason;
}

/** Relayed composer text: the words one device is typing, for the others. */
export interface SharedComposerDraft {
  sessionId: string;
  text: string;
  /** The page that sent it; the sender ignores its own echo. */
  origin: string;
}

/**
 * What a client may do to a session's shared queue. The host is the only
 * dispatcher; these are requests, and the resulting state arrives as
 * `composer/state`.
 */
export type SharedComposerCommand =
  | {
      sessionId: string;
      action: 'enqueue';
      item: {
        text: string;
        images?: PromptImage[];
        pins?: ChatPin[];
        compaction?: { instructions?: string };
      };
    }
  | { sessionId: string; action: 'remove'; itemId: string }
  | { sessionId: string; action: 'move'; itemId: string; targetId: string }
  /** Run this item now (steer while streaming, a new turn while idle). */
  | { sessionId: string; action: 'send'; itemId: string }
  /** Clear the pause and run the head now. */
  | { sessionId: string; action: 'continue' }
  /** Clear the pause only; the queue drains on the next natural finish. */
  | { sessionId: string; action: 'resume' };
