import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../host/morse.service';
import { ModePrefs } from './mode-prefs';
import { UnreadSessions } from './unread-sessions';

interface Row {
  id: string;
  title: string;
  updatedAt: number;
  messageCount?: number;
}

function setup(opts: {
  storedSeen?: Record<string, number>;
  storedCounts?: Record<string, number>;
  storedAlive?: number;
  sessions?: Row[];
  active?: string;
  streaming?: string[];
  user?: string;
  complete?: boolean;
} = {}) {
  localStorage.clear();
  const scope = opts.user ?? 'single';
  if (opts.storedSeen !== undefined) {
    localStorage.setItem(`morse.unread2-finished-seen:${scope}`, JSON.stringify(opts.storedSeen));
  }
  if (opts.storedCounts !== undefined) {
    localStorage.setItem(`morse.unread2-finished-counts:${scope}`, JSON.stringify(opts.storedCounts));
  }
  if (opts.storedAlive !== undefined) {
    localStorage.setItem(`morse.unread2-alive:${scope}`, JSON.stringify(opts.storedAlive));
  }
  const sessions = signal<Row[]>(opts.sessions ?? []);
  const state = signal<{ sessionId?: string }>({ sessionId: opts.active });
  const activity = signal(
    new Map((opts.streaming ?? []).map((id) => [id, { streaming: true }] as const)),
  );
  const user = signal(opts.user === undefined ? null : { id: opts.user });
  const loaded = signal(opts.complete ?? false);
  const hasMore = signal<Record<string, boolean>>({});
  const epoch = signal(1);
  const requestSessions = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MorseService,
        useValue: {
          sessions: sessions as Signal<Row[]>,
          state: state as Signal<{ sessionId?: string }>,
          sessionActivity: activity as Signal<Map<string, { streaming: boolean }>>,
          user: user as Signal<{ id: string } | null>,
          sessionsLoaded: loaded as Signal<boolean>,
          sessionHasMore: hasMore as Signal<Record<string, boolean>>,
          hostEpoch: epoch as Signal<number>,
          requestSessions,
        },
      },
    ],
  });
  const unread = TestBed.inject(UnreadSessions);
  TestBed.tick();
  return { unread, sessions, state, activity, user, loaded, requestSessions };
}

afterEach(() => {
  localStorage.clear();
  TestBed.resetTestingModule();
});

describe('UnreadSessions', () => {
  it('seeds silently on a first visit', () => {
    const { unread } = setup({
      sessions: [
        { id: 'a', title: 'A', updatedAt: 100 },
        { id: 'b', title: 'B', updatedAt: 200 },
      ],
    });
    expect(unread.ids().size).toBe(0);
  });

  it('keeps a session read when only its title or timestamp changed', () => {
    const { unread } = setup({
      storedSeen: { a: 100 },
      storedCounts: { a: 5 },
      sessions: [{ id: 'a', title: 'Renamed', updatedAt: 200, messageCount: 5 }],
    });
    expect(unread.has('a')).toBe(false);
  });

  it('still marks a session that gained messages', () => {
    const { unread } = setup({
      storedSeen: { a: 100 },
      storedCounts: { a: 5 },
      sessions: [{ id: 'a', title: 'A', updatedAt: 200, messageCount: 6 }],
    });
    expect(unread.has('a')).toBe(true);
  });

  it('marks sessions that moved while the browser was closed', () => {
    const { unread } = setup({
      storedSeen: { a: 100, b: 100 },
      sessions: [
        { id: 'a', title: 'A', updatedAt: 100 },
        { id: 'b', title: 'B', updatedAt: 200 },
      ],
    });
    expect(unread.has('a')).toBe(false);
    expect(unread.has('b')).toBe(true);
  });

  it('marks only the away window, never old pages', () => {
    const now = Date.now();
    const { unread } = setup({
      storedSeen: { a: 100 },
      storedAlive: now - 3_600_000,
      sessions: [
        { id: 'a', title: 'A', updatedAt: 100 },
        // Finished while the browser was closed: news.
        { id: 'b', title: 'B', updatedAt: now - 1_800_000 },
        // An old row on a page the catalog just loaded: history, not news.
        { id: 'c', title: 'C', updatedAt: 50 },
      ],
    });
    expect(unread.has('a')).toBe(false);
    expect(unread.has('b')).toBe(true);
    expect(unread.has('c')).toBe(false);
  });

  it('ignores old sessions on pages loaded while browsing', () => {
    const { unread } = setup({
      storedSeen: { a: 100 },
      storedAlive: Date.now(),
      sessions: [
        { id: 'a', title: 'A', updatedAt: 100 },
        { id: 'b', title: 'B', updatedAt: 50 },
      ],
    });
    expect(unread.ids().size).toBe(0);
  });

  it('fetches the session list on its own so bot mode learns finishes', () => {
    const { requestSessions, loaded } = setup();
    // Asked once without any visit to code mode; never again per connection.
    expect(requestSessions).toHaveBeenCalledTimes(1);
    loaded.set(true);
    TestBed.tick();
    expect(requestSessions).toHaveBeenCalledTimes(1);
  });

  it('clears one session without clearing the other', () => {
    const { unread } = setup({
      storedSeen: { a: 100, b: 100 },
      sessions: [
        { id: 'a', title: 'A', updatedAt: 200 },
        { id: 'b', title: 'B', updatedAt: 300 },
      ],
    });
    expect(unread.ids().size).toBe(2);
    unread.clear('a');
    expect(unread.has('a')).toBe(false);
    expect(unread.has('b')).toBe(true);
  });

  it('never marks the session in front or one still running', () => {
    const { unread } = setup({
      storedSeen: { a: 100, b: 100 },
      sessions: [
        { id: 'a', title: 'A', updatedAt: 200 },
        { id: 'b', title: 'B', updatedAt: 200 },
      ],
      active: 'a',
      streaming: ['b'],
    });
    expect(unread.ids().size).toBe(0);
  });

  it('marks the front session while in bot mode', () => {    const { unread, sessions } = setup({
      storedSeen: { a: 100 },
      sessions: [{ id: 'a', title: 'A', updatedAt: 100 }],
      active: 'a',
    });
    expect(unread.ids().size).toBe(0);
    // The reply lands while the reader is in the other mode: the front
    // session is not being read, so its finish is news.
    TestBed.inject(ModePrefs).setMode('bot');
    TestBed.tick();
    sessions.set([{ id: 'a', title: 'A', updatedAt: 200 }]);
    TestBed.tick();
    expect(unread.has('a')).toBe(true);
  });

  it('waits for the list on a fresh visit instead of marking it', () => {
    const { unread, sessions } = setup();
    expect(unread.ids().size).toBe(0);
    // The catalog arrives after the handshake: seeding, not news.
    sessions.set([{ id: 'a', title: 'A', updatedAt: 200 }]);
    TestBed.tick();
    expect(unread.ids().size).toBe(0);
  });

  it('keeps each login in its own bucket', () => {
    const { unread, user } = setup({ user: 'alice' });
    // Alice has no record: her empty list seeds nothing.
    expect(unread.ids().size).toBe(0);
    // Bob's record lands on the same browser; signing in as him shows only it.
    localStorage.setItem('morse.unread2-finished:bob', JSON.stringify(['x']));
    localStorage.setItem('morse.unread2-finished-seen:bob', JSON.stringify({ x: 100 }));
    user.set({ id: 'bob' });
    TestBed.tick();
    expect(unread.has('x')).toBe(true);
    expect(unread.ids().size).toBe(1);
  });

  it('drops dots for deleted sessions once the catalog is whole', () => {
    localStorage.clear();
    localStorage.setItem('morse.unread2-finished:single', JSON.stringify(['gone']));
    const { unread } = setup({
      storedSeen: { a: 100 },
      sessions: [{ id: 'a', title: 'A', updatedAt: 100 }],
      complete: true,
    });
    expect(unread.has('gone')).toBe(false);
    expect(unread.ids().size).toBe(0);
  });
});
