import { computed, DestroyRef, inject, Injectable } from '@angular/core';
import type { PromptMode } from '@morse/protocol';
import { MorseService } from '../host/morse.service';
import { ComposerDrafts } from '../state/composer-drafts';
import { QueuedPrompts, type QueuedPrompt } from '../state/queued-prompts';

/** How long a pause in typing waits before the other devices see the words. */
const DRAFT_RELAY_MS = 250;

type NewQueuedPrompt = Omit<QueuedPrompt, 'id' | 'sessionId'>;

/**
 * The bridge between the composer's local stores and a host that shares them.
 *
 * On a host with `capabilities.sharedComposer` the queue belongs to the host:
 * the composer sends requests (`composer/queue`) and this service applies the
 * broadcast to `QueuedPrompts`, so every device shows the same items, ids and
 * pause. The words being typed are relayed too (`composer/draft`), debounced;
 * the sender ignores its own echo by `origin`.
 *
 * On a host without it — VS Code's single webview — every method falls through
 * to today's local stores, so the composer has one code path and the extension
 * behaves exactly as before.
 */
@Injectable({ providedIn: 'root' })
export class ComposerSync {
  private readonly morse = inject(MorseService);
  private readonly queue = inject(QueuedPrompts);
  private readonly drafts = inject(ComposerDrafts);
  private readonly destroyRef = inject(DestroyRef);
  /** This page's identity in the draft relay; its own echo is skipped. */
  private readonly origin =
    globalThis.crypto?.randomUUID?.() ?? `page-${Math.random().toString(36).slice(2)}`;
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

  protected readonly shared = computed(() => this.morse.sharedComposer());

  constructor() {
    this.morse.onComposerState((state) =>
      this.queue.replaceSession(state.sessionId, state.queue, state.paused),
    );
    this.morse.onComposerDraft((draft) => {
      if (draft.origin !== this.origin) {
        this.drafts.setFor(draft.sessionId, draft.text);
      }
    });
    this.destroyRef.onDestroy(() => {
      for (const timer of this.draftTimers.values()) {
        clearTimeout(timer);
      }
      this.draftTimers.clear();
    });
  }

  /**
   * Queues a compaction where it belongs in the order — through the same
   * route as a follow-up, so a shared host owns it instead of page memory
   * (where the page drain, disabled on shared hosts, would leave it stuck).
   */
  enqueueCompaction(instructions: string | undefined, owner: string | undefined): void {
    this.enqueue(
      {
        text: 'Compact context',
        images: [],
        pins: [],
        compaction: instructions === undefined ? {} : { instructions },
      },
      owner,
    );
  }

  /** Queues a follow-up: a host request, or the local store on a single-client host. */
  enqueue(prompt: NewQueuedPrompt, owner: string | undefined): void {
    if (this.isShared(owner)) {
      this.morse.composerQueue({ sessionId: owner, action: 'enqueue', item: prompt });
      return;
    }
    this.queue.enqueue(prompt, owner);
  }

  remove(owner: string | undefined, item: QueuedPrompt): void {
    if (this.isShared(owner)) {
      this.morse.composerQueue({ sessionId: owner, action: 'remove', itemId: item.id });
      return;
    }
    this.queue.remove(item.id);
  }

  move(owner: string | undefined, itemId: string, targetId: string): void {
    if (this.isShared(owner)) {
      this.morse.composerQueue({ sessionId: owner, action: 'move', itemId, targetId });
      return;
    }
    this.queue.move(itemId, targetId);
  }

  /** Runs one item now (the composer chooses steer while a run is live). */
  sendNow(owner: string | undefined, item: QueuedPrompt, mode: PromptMode): void {
    if (this.isShared(owner)) {
      this.morse.composerQueue({ sessionId: owner, action: 'send', itemId: item.id });
      return;
    }
    this.queue.remove(item.id);
    this.morse.prompt(item.text, mode, item.images, item.pins, owner);
  }

  /** Clears the pause and runs the queue head now. */
  continueQueue(owner: string | undefined): void {
    if (this.isShared(owner)) {
      this.morse.composerQueue({ sessionId: owner, action: 'continue' });
    }
  }

  /** Clears the pause only; the next natural finish drains the queue. */
  resume(owner: string | undefined): void {
    if (this.isShared(owner)) {
      this.morse.composerQueue({ sessionId: owner, action: 'resume' });
    }
  }

  /** Relays this composer's text to the other devices, one pause at a time. */
  draft(owner: string | undefined, text: string): void {
    if (!this.isShared(owner)) {
      return;
    }
    const existing = this.draftTimers.get(owner);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.draftTimers.set(
      owner,
      setTimeout(() => {
        this.draftTimers.delete(owner);
        this.morse.composerDraft({ sessionId: owner, text, origin: this.origin });
      }, DRAFT_RELAY_MS),
    );
  }

  private isShared(owner: string | undefined): owner is string {
    return owner !== undefined && owner.length > 0 && this.shared();
  }
}
