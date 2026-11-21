import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { SessionActivity } from '@morse/protocol';
import { MorseService } from '../host/morse.service';

/**
 * When each session's current run began, keyed by session.
 *
 * The composer's "Working 12s" used to own this map, so the clock lived exactly
 * as long as the composer did: a file tab, the bot column, an empty panel or a
 * closed session tab unmounted it, and the next visit restarted the count from
 * zero. A run continues while the reader looks elsewhere, so the clock belongs
 * to the shell — this service lives for the page and anchors a start the moment
 * the host reports the session working, including a background one.
 *
 * The anchor is the first report, the earliest instant the client can know: the
 * wire carries *that* a run is going, not when it began. A page reload therefore
 * starts a new page clock, while every tab, mode and remount inside it shares
 * this one.
 */
@Injectable({ providedIn: 'root' })
export class RunClock {
  private readonly morse = inject(MorseService);
  /** Epoch milliseconds each session's current run was first seen running. */
  private readonly starts = signal<ReadonlyMap<string, number>>(new Map());

  constructor() {
    effect(() => {
      const activity = this.morse.sessionActivity();
      untracked(() => {
        const now = Date.now();
        this.starts.update((current) => {
          let next: Map<string, number> | undefined;
          for (const entry of activity.values()) {
            const running = isRunning(entry);
            const known = current.has(entry.sessionKey);
            if (running && !known) {
              next ??= new Map(current);
              next.set(entry.sessionKey, now);
            } else if (!running && known) {
              next ??= new Map(current);
              next.delete(entry.sessionKey);
            }
          }
          return next ?? current;
        });
      });
    });
  }

  /**
   * The start of `key`'s run, seeding it when no activity entry has named the
   * session yet — a draft tab becomes a session only once its prompt is sent.
   * A known start is never replaced, so remounting the surface reads the same
   * clock instead of a new one.
   */
  start(key: string): number {
    const known = this.starts().get(key);
    if (known !== undefined) {
      return known;
    }
    const now = Date.now();
    this.starts.update((current) =>
      current.has(key) ? current : new Map(current).set(key, now),
    );
    return this.starts().get(key) ?? now;
  }

  /**
   * Drops `key`'s clock unless live activity still reports the session running.
   * The surface calls this when its run ends; a background run is left alone.
   */
  release(key: string): void {
    const entry = this.morse.sessionActivity().get(key);
    if (entry !== undefined && isRunning(entry)) {
      return;
    }
    this.starts.update((current) => {
      if (!current.has(key)) {
        return current;
      }
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }

  /** How long `key`'s run has been going at `now`, or 0 when none is recorded. */
  elapsed(key: string | undefined, now: number): number {
    const start = key === undefined ? undefined : this.starts().get(key);
    return start === undefined ? 0 : Math.max(0, now - start);
  }
}

/**
 * A session switch or a compaction is time the reader waits for too, so it
 * starts the clock; the turn that follows continues the same count.
 */
function isRunning(entry: SessionActivity): boolean {
  return entry.streaming || entry.busy;
}
