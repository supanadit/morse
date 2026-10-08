import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore } from '../state/attachments';
import { MorseService } from '../host/morse.service';
import { NotificationPrefs } from '../state/notification-prefs';
import { RunNotifier } from './run-notifier';

type Activity = Map<string, { streaming: boolean }>;

function setup(capabilities: Record<string, unknown> = {}) {
  const activity = signal<Activity>(new Map());
  const caps = signal<Record<string, unknown>>(capabilities);
  const sessions = signal<{ id: string; title: string }[]>([]);
  const sent: { command: string; args?: Record<string, unknown> }[] = [];
  const fake = {
    sessionActivity: activity as Signal<Activity>,
    capabilities: caps as Signal<Record<string, unknown>>,
    sessions,
    hostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
      sent.push({ command, args });
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
  const prefs = TestBed.inject(NotificationPrefs);
  // The notifier is opt-in: most tests exercise it switched on.
  prefs.setEnabled(true);
  TestBed.inject(RunNotifier);
  return { activity, caps, sessions, sent, prefs };
}

/** The reader is looking at another window, not the panel. */
function away(): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  TestBed.resetTestingModule();
});

describe('RunNotifier', () => {
  it('asks the host to notify when a run finishes away from the panel', () => {
    const { activity, sessions, sent } = setup({ notify: true });
    away();
    sessions.set([{ id: 's1', title: 'Sidebar overhaul' }]);

    // The first report only seeds the state: an already-idle session is not news.
    activity.set(new Map([['s1', { streaming: false }]]));
    TestBed.tick();
    expect(sent).toHaveLength(0);

    activity.set(new Map([['s1', { streaming: true }]]));
    TestBed.tick();
    activity.set(new Map([['s1', { streaming: false }]]));
    TestBed.tick();

    expect(sent).toEqual([
      { command: 'notify', args: { title: 'Morse', body: '“Sidebar overhaul” finished' } },
    ]);
  });

  it('stays quiet while the panel is on screen and focused', () => {
    const { activity, sent } = setup({ notify: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    activity.set(new Map([['s1', { streaming: true }]]));
    TestBed.tick();
    activity.set(new Map([['s1', { streaming: false }]]));
    TestBed.tick();

    expect(sent).toHaveLength(0);
  });

  it('counts several sessions in one notification', () => {
    const { activity, sent } = setup({ notify: true });
    away();

    activity.set(
      new Map([
        ['s1', { streaming: true }],
        ['s2', { streaming: true }],
      ]),
    );
    TestBed.tick();
    activity.set(
      new Map([
        ['s1', { streaming: false }],
        ['s2', { streaming: false }],
      ]),
    );
    TestBed.tick();

    expect(sent).toEqual([
      { command: 'notify', args: { title: 'Morse', body: '2 sessions finished' } },
    ]);
  });

  it('stays silent while the feature is switched off', () => {
    const { activity, sent, prefs } = setup({ notify: true });
    away();
    prefs.disable();

    activity.set(new Map([['s1', { streaming: true }]]));
    TestBed.tick();
    activity.set(new Map([['s1', { streaming: false }]]));
    TestBed.tick();

    expect(sent).toHaveLength(0);
  });

  it('notifies while the panel is focused when the mode is `always`', () => {
    const { activity, sent, prefs } = setup({ notify: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    prefs.setMode('always');

    activity.set(new Map([['s1', { streaming: true }]]));
    TestBed.tick();
    activity.set(new Map([['s1', { streaming: false }]]));
    TestBed.tick();

    expect(sent).toHaveLength(1);
  });

  it('uses the browser Notification API where the host cannot notify', () => {
    const shown: { title: string; body?: string }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, body: options?.body });
      }
      close(): void {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    const { activity } = setup({});
    away();

    activity.set(new Map([['s1', { streaming: true }]]));
    TestBed.tick();
    activity.set(new Map([['s1', { streaming: false }]]));
    TestBed.tick();

    expect(shown).toEqual([{ title: 'Morse', body: 'A session finished' }]);
  });

  it('turns the preference on only after the browser grants permission', async () => {
    const { prefs } = setup({});
    prefs.disable();
    const requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });

    await TestBed.inject(RunNotifier).optIn();

    // The prompt is what turns it on, not the click alone.
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(prefs.enabled()).toBe(true);
  });

  it('leaves it off, and says so, when the prompt is blocked', async () => {
    const { prefs } = setup({});
    prefs.disable();
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn(async (): Promise<NotificationPermission> => 'denied'),
    });
    const say = vi.spyOn(TestBed.inject(AttachmentStore), 'say');

    await TestBed.inject(RunNotifier).optIn();

    expect(prefs.enabled()).toBe(false);
    expect(say).toHaveBeenCalledWith('warn', 'Notifications are blocked for this site.');
  });

  it('re-reads the browser permission when the page regains focus', () => {
    const api = { permission: 'granted' };
    vi.stubGlobal('Notification', api);
    setup({});
    const notifier = TestBed.inject(RunNotifier);
    expect(notifier.permission()).toBe('granted');

    // The reader reset the site setting while the tab was away.
    api.permission = 'denied';
    window.dispatchEvent(new Event('focus'));

    expect(notifier.permission()).toBe('denied');
  });

  it('falls back to an in-app toast when there is no Notification API', () => {
    vi.stubGlobal('Notification', undefined);
    const { activity } = setup({});
    away();
    const say = vi.spyOn(TestBed.inject(AttachmentStore), 'say');

    activity.set(new Map([['s1', { streaming: true }]]));
    TestBed.tick();
    activity.set(new Map([['s1', { streaming: false }]]));
    TestBed.tick();

    expect(say).toHaveBeenCalledWith('info', 'Morse: A session finished');
  });
});
