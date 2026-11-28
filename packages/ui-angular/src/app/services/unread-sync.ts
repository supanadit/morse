import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { MorseService } from '../host/morse.service';
import { UnreadBots, type BotUnreadData } from '../state/unread-bots';
import { UnreadSessions, type SessionUnreadData } from '../state/unread-sessions';

/** Bumped when the inner shape changes; a host file from another build is ignored. */
export const UNREAD_VERSION = 1;

export interface UnreadData {
  sessions: SessionUnreadData;
  bots: BotUnreadData;
}

/** Reading a room is one event, but a burst of marks is one save. */
const SAVE_DEBOUNCE_MS = 350;

/**
 * Keeps unread marks on the host instead of only in this browser: the state a
 * reader marked on one device is already read when they open another. The host
 * owns the file (per user once multiuser is on); the frontend owns the shape,
 * just as it does for the workbench layout and drafts.
 *
 * The local `localStorage` copy in each unread service stays as a fast path for
 * other tabs of the same browser. The host copy is the shared truth: it is read
 * on handshake and written after changes, never the other way round.
 */
@Injectable({ providedIn: 'root' })
export class UnreadSync {
  private readonly morse = inject(MorseService);
  private readonly sessions = inject(UnreadSessions);
  private readonly bots = inject(UnreadBots);
  private readonly destroyRef = inject(DestroyRef);
  /** False until the first load has been attempted, so a restore cannot be saved back. */
  private readonly ready = signal(false);
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWritten: string | undefined;

  constructor() {
    effect(() => {
      const connected = this.morse.connection() === 'ready';
      const capable = this.morse.capabilities()?.workbench === true;
      if (connected && capable && !this.started) {
        this.started = true;
        void this.load();
      }
    });

    effect(() => {
      if (!this.ready()) {
        return;
      }
      // Reading both snapshots tracks the signals they are made of, so a mark,
      // a clear or a catch-up reconciliation schedules one save.
      if (JSON.stringify(this.snapshot().data) === this.lastWritten) {
        return;
      }
      this.schedule();
    });

    if (typeof document !== 'undefined') {
      const flush = (): void => this.flush();
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') flush();
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', flush);
      this.destroyRef.onDestroy(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', flush);
      });
    }
    this.destroyRef.onDestroy(() => {
      if (this.timer !== undefined) clearTimeout(this.timer);
    });
  }

  private async load(): Promise<void> {
    try {
      const saved = await this.morse.requestHostCommand('readUnread');
      const data = asUnreadData(saved);
      if (data !== undefined) {
        this.sessions.restore(data.sessions);
        this.bots.restore(data.bots);
      }
    } catch {
      // A host without the slot leaves this browser's marks alone; the next
      // change still writes them, so nothing is lost by an older host.
    } finally {
      // What is on screen now is what a save would write.
      this.lastWritten = JSON.stringify(this.snapshot().data);
      this.ready.set(true);
    }
  }

  private snapshot(): { version: number; data: UnreadData } {
    return {
      version: UNREAD_VERSION,
      data: {
        sessions: this.sessions.snapshot(),
        bots: this.bots.snapshot(),
      },
    };
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private writeNow(): void {
    const snapshot = this.snapshot();
    const serialized = JSON.stringify(snapshot.data);
    if (serialized === this.lastWritten) {
      return;
    }
    this.lastWritten = serialized;
    void this.morse
      .requestHostCommand('saveUnread', { version: snapshot.version, data: snapshot.data })
      .catch(() => undefined);
  }

  /** A mark made just before the page closed still reaches the host. */
  private flush(): void {
    if (!this.ready()) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.writeNow();
  }
}

function asUnreadData(value: unknown): UnreadData | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope['version'] !== UNREAD_VERSION) {
    return undefined;
  }
  const data = envelope['data'];
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (
    typeof record['sessions'] !== 'object' ||
    record['sessions'] === null ||
    typeof record['bots'] !== 'object' ||
    record['bots'] === null
  ) {
    return undefined;
  }
  return record as unknown as UnreadData;
}
