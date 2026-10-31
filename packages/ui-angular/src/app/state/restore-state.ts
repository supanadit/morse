import { Injectable, signal } from '@angular/core';

/**
 * True while the shell is still putting a saved session back on screen: the
 * workbench layout is travelling from the host and the restored conversation's
 * transcript has not arrived yet.
 *
 * Its one job is safety. A panel that looks empty reads as a brand-new session,
 * and a prompt typed into it opens a throwaway conversation in front of the one
 * coming back — the reader cannot tell "restoring" from "nothing here yet".
 * While the flag is up the panel shows a loading screen, the composer stays
 * unmounted, and `MorseService.prompt` refuses to send.
 *
 * The flag fails open: `end()` is also armed on a watchdog, so a host that never
 * answers (a lost capability flag, a stalled read) can hold the panel for at
 * most `WATCHDOG_MS`, after which the ordinary welcome or transcript takes over.
 */
@Injectable({ providedIn: 'root' })
export class RestoreState {
  /** A stalled restore gives the panel back rather than spinning forever. */
  static readonly WATCHDOG_MS = 10_000;

  private readonly restoring = signal(false);
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  /** Read by the shell (the loading screen) and the send guard. */
  readonly isRestoring = this.restoring.asReadonly();

  /** Raises the flag and arms the watchdog. Safe to call again while raised. */
  begin(): void {
    this.clearWatchdog();
    this.restoring.set(true);
    this.watchdog = setTimeout(() => this.end(), RestoreState.WATCHDOG_MS);
  }

  /** Lowers the flag; the panel shows whatever actually arrived. */
  end(): void {
    this.clearWatchdog();
    this.restoring.set(false);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
    }
  }
}
