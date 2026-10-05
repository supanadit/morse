import { Injectable, signal } from '@angular/core';

/**
 * When a finished run should say so:
 *
 * - `away` (default): only when the panel is hidden or unfocused — the answer is
 *   already on screen otherwise, so a ping is noise;
 * - `always`: every time, even while the reader is watching.
 */
export type NotificationMode = 'away' | 'always';

/**
 * Where the choice is remembered. A webview or a browser with storage disabled
 * simply forgets it — the toggle still works for the session.
 */
const ENABLED_KEY = 'morse.notifications.enabled';
const MODE_KEY = 'morse.notifications.mode';
/** The "notifications are off" nudge was answered, so it stops asking. */
const BANNER_KEY = 'morse.notifications.banner';

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function storeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    // Storage is a nicety, not a requirement: the signal still holds the choice.
  }
}

function isMode(value: unknown): value is NotificationMode {
  return value === 'away' || value === 'always';
}

function readMode(): NotificationMode {
  try {
    const raw = globalThis.localStorage?.getItem(MODE_KEY);
    return isMode(raw) ? raw : 'away';
  } catch {
    return 'away';
  }
}

/**
 * Whether a finished run is announced, and how eagerly. A reader preference, not
 * the host's to decide — a browser and a VS Code webview are two windows onto the
 * same sessions, and each may want its own answer.
 *
 * Off by default, so the first visit shows the one-time nudge (`banner`) rather
 * than guessing: a browser that pops its permission prompt unbidden, or a VS Code
 * user who never wanted a toast, is worse than asking once.
 */
@Injectable({ providedIn: 'root' })
export class NotificationPrefs {
  private readonly enabledSignal = signal(readFlag(ENABLED_KEY, false));
  readonly enabled = this.enabledSignal.asReadonly();
  private readonly modeSignal = signal<NotificationMode>(readMode());
  readonly mode = this.modeSignal.asReadonly();
  private readonly bannerSignal = signal(readFlag(BANNER_KEY, false));
  /** The nudge was turned on or dismissed, so it never asks again. */
  readonly bannerDismissed = this.bannerSignal.asReadonly();

  /** Turns notifications on or off. Any explicit choice also retires the nudge. */
  setEnabled(enabled: boolean): void {
    this.enabledSignal.set(enabled);
    storeFlag(ENABLED_KEY, enabled);
    this.dismissBanner();
  }

  enable(): void {
    this.setEnabled(true);
  }

  disable(): void {
    this.setEnabled(false);
  }

  toggle(): void {
    this.setEnabled(!this.enabledSignal());
  }

  setMode(mode: NotificationMode): void {
    this.modeSignal.set(mode);
    try {
      globalThis.localStorage?.setItem(MODE_KEY, mode);
    } catch {
      // As above.
    }
  }

  /** `away` and `always` are the only two, so a toggle is the whole choice. */
  toggleMode(): void {
    this.setMode(this.modeSignal() === 'away' ? 'always' : 'away');
  }

  dismissBanner(): void {
    this.bannerSignal.set(true);
    storeFlag(BANNER_KEY, true);
  }
}
