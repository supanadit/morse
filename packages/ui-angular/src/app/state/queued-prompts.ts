import { Injectable, computed, signal } from '@angular/core';
import type { ChatPin, PromptImage } from '@morse/protocol';

/**
 * A follow-up the user queued while the agent was working. The words and the
 * attachments are the whole prompt, snapshotted the moment it was queued so
 * editing the queue later cannot lose what was attached.
 */
export interface QueuedPrompt {
  id: string;
  text: string;
  images: PromptImage[];
  pins: ChatPin[];
  /** The session it was queued for, so a settle elsewhere cannot dispatch it. */
  sessionId?: string;
}

/**
 * Follow-ups waiting their turn. The composer queues them instead of handing
 * them straight to pi, so the reader can see, edit or drop each one before it
 * runs — pi's own queue is invisible and can only be cleared whole.
 *
 * Frontend shell state, not wire state: like a half-typed prompt, the queue is
 * in-memory and does not survive a reload. The composer drains it one prompt per
 * completed run.
 */
@Injectable({ providedIn: 'root' })
export class QueuedPrompts {
  private readonly items = signal<readonly QueuedPrompt[]>([]);
  private counter = 0;

  readonly queued = this.items.asReadonly();
  readonly count = computed(() => this.items().length);

  /** The prompts waiting for `owner`, oldest first — the tab in front's own queue. */
  forOwner(owner: string | undefined): readonly QueuedPrompt[] {
    return this.items().filter((item) => item.sessionId === owner);
  }

  /** The oldest prompt queued for `sessionId` — the one that runs next. */
  head(sessionId?: string): QueuedPrompt | undefined {
    return this.items().find((item) => item.sessionId === sessionId);
  }

  enqueue(prompt: Omit<QueuedPrompt, 'id' | 'sessionId'>, sessionId?: string): string {
    this.counter += 1;
    const id = `queued-${this.counter}`;
    this.items.update((list) => [...list, { ...prompt, id, sessionId }]);
    return id;
  }

  remove(id: string): void {
    this.items.update((list) => list.filter((item) => item.id !== id));
  }

  /**
   * True when `id` can be dropped on `targetId`: two different prompts of the
   * same session. The composer only shows one session's queue, so a cross-session
   * drop cannot happen — but the store guards it anyway, the way the tab strip does.
   */
  canMove(id: string, targetId: string): boolean {
    if (id === targetId) {
      return false;
    }
    const items = this.items();
    const from = items.find((item) => item.id === id);
    const to = items.find((item) => item.id === targetId);
    return from !== undefined && to !== undefined && from.sessionId === to.sessionId;
  }

  /**
   * Reorders a prompt, putting it where it was dropped: dragged downward it lands
   * after the prompt it was dropped on, upward before it — the same rule the tab
   * strip uses. The order is what `shift` reads, so this is how a reader chooses
   * which follow-up runs first.
   */
  move(id: string, targetId: string): void {
    if (!this.canMove(id, targetId)) {
      return;
    }
    const items = this.items();
    const from = items.findIndex((item) => item.id === id);
    const to = items.findIndex((item) => item.id === targetId);
    const moved = items[from]!;
    const next = items.filter((item) => item.id !== id);
    const target = next.findIndex((item) => item.id === targetId);
    next.splice(from < to ? target + 1 : target, 0, moved);
    this.items.set(next);
  }

  /** Removes and returns the oldest prompt queued for `sessionId`, if any. */
  shift(sessionId?: string): QueuedPrompt | undefined {
    const item = this.head(sessionId);
    if (item === undefined) {
      return undefined;
    }
    this.remove(item.id);
    return item;
  }

  clear(): void {
    this.items.set([]);
  }

  /** A draft tab became the session that owns it; its queue follows the new id. */
  rekey(from: string, to: string): void {
    this.items.update((list) =>
      list.map((item) => (item.sessionId === from ? { ...item, sessionId: to } : item)),
    );
  }

  /** A closed tab's queue has nowhere to return to. */
  forgetOwner(owner: string | undefined): void {
    this.items.update((list) => list.filter((item) => item.sessionId !== owner));
  }
}
