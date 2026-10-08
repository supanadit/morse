import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { MorseService } from '../host/morse.service';
import { AttachmentStore } from '../state/attachments';
import { NotificationPrefs } from '../state/notification-prefs';
import {
  isWindowFocused,
  readPermission,
  requestNotificationPermission,
  showWebNotification,
  trackNotificationPermission,
  type NotificationPermissionState,
} from './notification-channel';

/**
 * Tells the reader when a run finishes while they are looking elsewhere.
 *
 * Only an *end* is news: a session's `streaming` flag going true → false. Whether
 * the ping is raised is the reader's preference (`NotificationPrefs`), and where
 * the panel is focused it is `away` by default — the answer is on screen, so a
 * notification is noise. A host with its own notifications (`capabilities.notify`,
 * VS Code, whose webview has no Web Notifications) raises one; the browser host
 * uses the `Notification` API, with an in-app toast as the last resort.
 *
 * The *how* is `notification-channel.ts`; this service is only the policy.
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
    const refresh = (): void => this.permissionSignal.set(readPermission());
    this.destroyRef.onDestroy(trackNotificationPermission(refresh));
    this.destroyRef.onDestroy(() => this.streaming.clear());
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

  private announce(keys: readonly string[]): void {
    if (!this.prefs.enabled()) {
      return;
    }
    // `away` (the default) keeps quiet while the answer is already on screen.
    if (this.prefs.mode() === 'away' && isWindowFocused()) {
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
    let permission = readPermission();
    if (permission === 'unsupported') {
      // No browser channel either: the in-app toast is all there is.
      this.prefs.enable();
      return;
    }
    // Only a browser that has not decided yet needs the async prompt; every other
    // answer is applied in this same turn, so the click handler is not left waiting
    // on a microtask before the nudge can retire.
    if (permission === 'default') {
      permission = await requestNotificationPermission();
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
    let permission = readPermission();
    if (permission === 'default') {
      permission = await requestNotificationPermission();
      this.permissionSignal.set(permission);
    }
    // Blocked (a denied prompt, an insecure origin, no API at all): say it where the
    // reader will still see it when they come back.
    if (permission !== 'granted' || !showWebNotification(body)) {
      this.fallback(body);
    }
  }

  private fallback(body: string): void {
    this.attachments.say('info', `Morse: ${body}`);
  }
}
