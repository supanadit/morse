import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { AttachmentStore } from './attachments';
import { MorseService } from './morse.service';
import { NotificationPrefs } from './notification-prefs';

/** The browser's answer for this origin, or `unsupported` when there is no API. */
export type NotificationPermissionState = NotificationPermission | 'unsupported';

function readPermission(): NotificationPermissionState {
  const api = (globalThis as { Notification?: typeof Notification }).Notification;
  return api === undefined ? 'unsupported' : api.permission;
}

/** The Permission API's live status, where the browser implements it. */
function queryPermission(): Promise<PermissionStatus> | undefined {
  const permissions = (
    globalThis as {
      navigator?: {
        permissions?: { query?: (descriptor: { name: string }) => Promise<PermissionStatus> };
      };
    }
  ).navigator?.permissions;
  try {
    return permissions?.query?.({ name: 'notifications' });
  } catch {
    return undefined;
  }
}

/**
 * Tells the reader when a run finishes while they are looking elsewhere.
 *
 * Only an *end* is news: a session's `streaming` flag going true → false. Whether
 * the ping is raised is the reader's preference (`NotificationPrefs`), and where
 * the panel is focused it is `away` by default — the answer is on screen, so a
 * notification is noise. A host with its own notifications (`capabilities.notify`,
 * VS Code, whose webview has no Web Notifications) raises one; the browser host
 * uses the `Notification` API, with an in-app toast as the last resort.
 */
@Injectable({ providedIn: 'root' })
export class RunNotifier {
  private readonly morse = inject(MorseService);
  private readonly attachments = inject(AttachmentStore);
  private readonly prefs = inject(NotificationPrefs);
  private readonly destroyRef = inject(DestroyRef);
  /** The last observed streaming state per session, so only a stop is news. */
  private streaming = new Map<string, boolean>();

  /**
   * The browser's live permission. A reader can revoke it from the site settings
   * at any time — an event the app does not control — so it is re-read on a focus
   * change and through the Permission API where it exists. Without this, turning
   * notifications on and then resetting the permission left the nudge gone for
   * good while desktop notifications silently never arrived.
   */
  private readonly permissionSignal = signal<NotificationPermissionState>(readPermission());
  readonly permission = this.permissionSignal.asReadonly();

  constructor() {
    effect(() => {
      const activity = this.morse.sessionActivity();
      untracked(() => this.watch(activity));
    });
    this.trackPermission();
    this.destroyRef.onDestroy(() => this.streaming.clear());
  }

  /** Re-reads the permission when the reader could have changed it. */
  private trackPermission(): void {
    const refresh = (): void => this.permissionSignal.set(readPermission());
    const doc = (globalThis as { document?: Document }).document;
    const win = globalThis as {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
    doc?.addEventListener('visibilitychange', refresh);
    win.addEventListener?.('focus', refresh);
    void queryPermission()
      ?.then((status) => {
        status.onchange = refresh;
      })
      .catch(() => undefined);
    this.destroyRef.onDestroy(() => {
      doc?.removeEventListener('visibilitychange', refresh);
      win.removeEventListener?.('focus', refresh);
    });
  }

  /** Diffs this report against the last one and announces whatever just stopped. */
  private watch(activity: ReadonlyMap<string, { streaming: boolean }>): void {
    const finished: string[] = [];
    for (const [key, entry] of activity) {
      if (this.streaming.get(key) === true && !entry.streaming) {
        finished.push(key);
      }
    }
    // A session that dropped out of the report was hot; if it was streaming, it
    // ended too (a closed tab, the registry evicting it).
    for (const [key, wasStreaming] of this.streaming) {
      if (wasStreaming && !activity.has(key)) {
        finished.push(key);
      }
    }
    this.streaming = new Map([...activity].map(([key, entry]) => [key, entry.streaming]));
    // The first report only seeds the map: everything already idle stays quiet.
    if (finished.length === 0) {
      return;
    }
    this.announce(finished);
  }

  /** Whether the panel is on screen *and* focused — the answer is already visible. */
  private looking(): boolean {
    const doc = (globalThis as { document?: Document }).document;
    if (doc === undefined) {
      return true;
    }
    return !doc.hidden && doc.hasFocus();
  }

  private announce(keys: readonly string[]): void {
    if (!this.prefs.enabled()) {
      return;
    }
    // `away` (the default) keeps quiet while the answer is already on screen.
    if (this.prefs.mode() === 'away' && this.looking()) {
      return;
    }
    const body = this.body(keys);
    if (this.morse.capabilities()?.notify === true) {
      this.morse.hostCommand('notify', { title: 'Morse', body });
      return;
    }
    void this.webNotify(body);
  }

  /**
   * Opts in from a user gesture: asks the browser for permission where the host
   * has none of its own, and only turns the preference on once it is granted — a
   * prompt the reader blocks must not leave the setting on with nothing to show
   * for it (the same flow a chat app uses). The `requestPermission` call is made
   * synchronously on the click, which is what makes the native prompt appear.
   */
  async optIn(): Promise<void> {
    if (this.morse.capabilities()?.notify === true) {
      this.prefs.enable();
      return;
    }
    const api = (globalThis as { Notification?: typeof Notification }).Notification;
    if (api === undefined) {
      // No browser channel either: the in-app toast is all there is.
      this.prefs.enable();
      return;
    }
    let permission = api.permission;
    if (permission === 'default') {
      try {
        permission = await api.requestPermission();
      } catch {
        permission = 'denied';
      }
    }
    this.permissionSignal.set(permission);
    if (permission === 'granted') {
      this.prefs.enable();
      return;
    }
    // Blocked: leave the preference off, so the nudge still offers the way in,
    // and say why a desktop notification will not appear.
    this.attachments.say('warn', 'Notifications are blocked for this site.');
  }

  private body(keys: readonly string[]): string {
    if (keys.length > 1) {
      return `${keys.length} sessions finished`;
    }
    const title = this.morse.sessions().find((session) => session.id === keys[0])?.title;
    return title !== undefined && title.length > 0 ? `“${title}” finished` : 'A session finished';
  }

  private async webNotify(body: string): Promise<void> {
    const api = (globalThis as { Notification?: typeof Notification }).Notification;
    if (api === undefined) {
      this.fallback(body);
      return;
    }
    let permission = api.permission;
    if (permission === 'default') {
      try {
        permission = await api.requestPermission();
      } catch {
        permission = 'denied';
      }
      this.permissionSignal.set(permission);
    }
    if (permission !== 'granted') {
      // Blocked (a denied prompt, an insecure origin): say it where the reader
      // will still see it when they come back.
      this.fallback(body);
      return;
    }
    const notification = new api('Morse', { body });
    notification.onclick = () => {
      (globalThis as { focus?: () => void }).focus?.();
      notification.close();
    };
  }

  private fallback(body: string): void {
    this.attachments.say('info', `Morse: ${body}`);
  }
}
