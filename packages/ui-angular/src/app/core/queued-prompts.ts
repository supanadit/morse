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
}
