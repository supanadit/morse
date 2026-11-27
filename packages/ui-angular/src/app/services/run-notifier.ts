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
import { NotificationSound } from './notification-sound';
import { UnreadSessions } from '../state/unread-sessions';
import { ModePrefs } from '../state/mode-prefs';

/**
 * Tells the reader when a run finishes while they are looking elsewhere.
 *
 * Only an *end* is news: a session's `streaming` flag going true → false, or a
 * bot round disappearing from `bot/routing`. Whether
 * the ping is raised is the reader's preference (`NotificationPrefs`), and where
 * the panel is focused it is `away` by default — the answer is on screen, so a
 * notification is noise. A finish in the *other* mode is never on screen, so it
 * always pings: a bot reply landing while the reader is in Code, and vice versa.
 * A host with its own notifications (`capabilities.notify`,
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
  private readonly sound = inject(NotificationSound);
  private readonly unread = inject(UnreadSessions);
  private readonly modes = inject(ModePrefs);
  private readonly destroyRef = inject(DestroyRef);
  /** The last observed streaming state per session, so only a stop is news. */
  private streaming = new Map<string, boolean>();
  /** Conversation ids with a round in flight at the last report. */
  private botRounds = new Set<string>();
  /** The login the maps above were seeded for; a change reseeds without a ping. */
  private lastScope = '';

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
    effect(() => {
      const routing = this.botRouting();
      untracked(() => this.watchBots(routing));
    });
    const refresh = (): void => this.permissionSignal.set(readPermission());
    this.destroyRef.onDestroy(trackNotificationPermission(refresh));
    this.destroyRef.onDestroy(() => this.streaming.clear());
    this.destroyRef.onDestroy(() => this.botRounds.clear());
  }

  /** Diffs this report against the last one and announces whatever just stopped. */
  private watch(activity: ReadonlyMap<string, { streaming: boolean }>): void {
    if (this.rescoped()) {
      this.streaming = new Map([...activity].map(([key, entry]) => [key, entry.streaming]));
      return;
    }
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
    // A finish in the session already in front is seen, not news to revisit —
    // but only while Code mode is on screen. In Bot mode the reader cannot
    // see any session, so every finish is news.
    const here = this.frontSessionId;
    this.unread.mark(here === undefined ? finished : finished.filter((id) => id !== here));
    this.announce(finished);
  }

  /** The session in front, if Code mode is what the reader is looking at. */
  private get frontSessionId(): string | undefined {
    try {
      if (this.modes.mode() !== 'code') return undefined;
      return (this.morse as { state?: () => { sessionId?: string } }).state?.()?.sessionId;
    } catch {
      return undefined;
    }
  }

  private announce(keys: readonly string[]): void {
    if (!this.prefs.enabled()) {
      return;
    }
    // `away` keeps quiet while the answer is already on screen — which is only
    // true in the same mode. A code run finishing while the reader is in Bot
    // mode lands nowhere they can see, so it always pings (and vice versa).
    if (this.prefs.mode() === 'away' && isWindowFocused() && this.modes.mode() === 'code') {
      return;
    }
    this.deliver(this.body(keys));
  }

  /** The bot half: rounds present at the last report that have since cleared. */
  private botRouting(): ReadonlySet<string> {
    const routing = (
      this.morse as { bot?: { routing?: () => Record<string, unknown> } }
    ).bot?.routing?.();
    return new Set(Object.keys(routing ?? {}));
  }

  private watchBots(running: ReadonlySet<string>): void {
    if (this.rescoped()) {
      this.botRounds = new Set(running);
      return;
    }
    const finished = [...this.botRounds].filter((id) => !running.has(id));
    this.botRounds = new Set(running);
    if (finished.length === 0) {
      return;
    }
    this.announceBots(finished);
  }

  private announceBots(ids: readonly string[]): void {
    if (!this.prefs.enabled()) {
      return;
    }
    // The room in front is being read when bot mode is on screen and focused;
    // anything else — another room, or any bot finish while in Code — is news.
    if (this.prefs.mode() === 'away' && isWindowFocused() && this.modes.mode() === 'bot') {
      const active = (
        this.morse as { bot?: { activeId?: () => string | null } }
      ).bot?.activeId?.();
      const news = active === undefined || active === null ? ids : ids.filter((id) => id !== active);
      if (news.length === 0) {
        return;
      }
      this.deliver(this.botBody(news));
      return;
    }
    this.deliver(this.botBody(ids));
  }

  /**
   * Raises one notice right now, on demand, so a reader can hear and see what a
   * real finish will do without waiting for a session. Deliberate, so `away` does
   * not suppress it; it still respects the on/off switch and the sound setting.
   */
  test(): void {
    if (!this.prefs.enabled()) {
      return;
    }
    this.deliver('Test notification — this is how a finished session will sound.');
  }

  private deliver(body: string): void {
    // The chime is part of the notice, not a separate channel: it follows the same
    // preference and mode gate above, and only its own switch can silence it.
    if (this.prefs.sound()) {
      this.sound.play();
    }
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

  /**
   * True when the login changed under the live maps (a different `user.id` than
   * they were seeded for). The other login's in-flight runs are not this
   * login's news, so the maps reseed silently instead of announcing.
   */
  private rescoped(): boolean {
    const scope = (
      this.morse as { user?: () => { id?: string } | null }
    ).user?.()?.id ?? 'single';
    if (scope === this.lastScope) return false;
    this.lastScope = scope;
    return true;
  }

  private body(keys: readonly string[]): string {
    if (keys.length > 1) {
      return `${keys.length} sessions finished`;
    }
    const title = this.morse.sessions().find((session) => session.id === keys[0])?.title;
    return title !== undefined && title.length > 0 ? `“${title}” finished` : 'A session finished';
  }

  private botBody(ids: readonly string[]): string {
    if (ids.length > 1) {
      return `${ids.length} bot replies finished`;
    }
    const title = (
      this.morse as { bot?: { roster?: () => { conversations?: { id: string; title: string }[] } | null } }
    ).bot?.roster?.()?.conversations?.find((conversation) => conversation.id === ids[0])?.title;
    return title !== undefined && title.length > 0 ? `Bot reply in “${title}” finished` : 'A bot reply finished';
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
