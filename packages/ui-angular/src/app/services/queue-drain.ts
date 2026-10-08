import { Injectable, effect, inject, untracked } from '@angular/core';
import type { SessionActivity } from '@morse/protocol';
import { MorseService } from '../host/morse.service';
import { QueuedPrompts, type QueuedPrompt } from '../state/queued-prompts';

/**
 * Sends each session's queued follow-ups as soon as *that* session stops
 * working, whether or not it is the tab in front.
 *
 * The drain used to live in `ChatComposer`, which only knows the session in
 * front: a follow-up queued in one tab waited until the reader came back to it,
 * even though its own run had long settled. A browser host runs several sessions
 * at once, so the decision belongs to the shell, not to a view — and the prompt
 * is addressed to its session (`sessionKey`) so a background one runs without
 * switching the panel to it.
 *
 * One prompt per settle, per session: the guard keeps a settle from dispatching
 * the whole queue in one tick before the run it started flips the session back
 * to working. A session that is not hot is left alone — its queue is kept for
 * when it is activated again, never dropped.
 */
@Injectable({ providedIn: 'root' })
export class QueueDrain {
  private readonly morse = inject(MorseService);
  private readonly queue = inject(QueuedPrompts);
  /** Sessions with a dispatched prompt whose run has not started yet. */
  private readonly dispatching = new Set<string>();

  constructor() {
    effect(() => {
      const activity = this.morse.sessionActivity();
      // Reading the queue is what makes an enqueue, reorder or removal re-run
      // the drain; `dispatching` alone would never notice a new item.
      const queued = this.queue.queued();
      untracked(() => this.drain(activity, queued));
    });
  }

  private drain(
    activity: ReadonlyMap<string, SessionActivity>,
    queued: readonly QueuedPrompt[],
  ): void {
    for (const owner of new Set(queued.map((item) => item.sessionId))) {
      if (owner === undefined) {
        // A draft has no agent to prompt yet; its queue follows the id once the
        // first prompt makes it a session (see `WorkspaceTabs.promoteDraft`).
        continue;
      }
      const current = activity.get(owner);
      if (current === undefined) {
        // Not hot: there is nothing to run it in. Keep the queue and try again
        // when the session is activated (or opened and re-published).
        this.dispatching.delete(owner);
        continue;
      }
      if (current.streaming || current.busy) {
        // A run (or a session switch) is in flight: the next item waits for it
        // to settle, so the queue keeps its order instead of racing the turn.
        this.dispatching.delete(owner);
        continue;
      }
      if (this.dispatching.has(owner)) {
        // Already sent one and the session has not flipped to working yet.
        continue;
      }
      const next = this.queue.shift(owner);
      if (next === undefined) {
        continue;
      }
      this.dispatching.add(owner);
      this.morse.prompt(next.text, 'new', next.images, next.pins, owner);
    }
  }
}
