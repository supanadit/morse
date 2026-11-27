import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MorseService } from '../host/morse.service';
import { ModePrefs } from './mode-prefs';
import { UnreadBots } from './unread-bots';

describe('UnreadBots', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('decrements by one when a single room is opened', () => {
    const unread = TestBed.inject(UnreadBots);
    unread.mark(['a', 'b']);
    expect(unread.count()).toBe(2);
    unread.clear('a');
    expect(unread.count()).toBe(1);
    expect(unread.has('b')).toBe(true);
  });

  it('marks rooms that moved while the browser was closed', () => {
    localStorage.clear();
    localStorage.setItem('morse.unread2-bots-seen:single', JSON.stringify({ c1: 100, c2: 100 }));
    const roster = signal({
      conversations: [
        { id: 'c1', updatedAt: 100 },
        { id: 'c2', updatedAt: 250 },
      ],
    });
    const transcripts = signal<Record<string, readonly unknown[]>>({});
    const activeId = signal<string | null>(null);
    const user = signal(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MorseService,
          useValue: {
            user: user as Signal<null>,
            bot: {
              roster: roster as Signal<{ conversations: { id: string; updatedAt: number }[] }>,
              transcripts: transcripts as Signal<Record<string, readonly unknown[]>>,
              activeId: activeId as Signal<string | null>,
            },
          },
        },
      ],
    });
    const unread = TestBed.inject(UnreadBots);
    TestBed.tick();
    expect(unread.has('c1')).toBe(false);
    expect(unread.has('c2')).toBe(true);
    unread.clear('c2');
    expect(unread.count()).toBe(0);
  });

  it('marks the open room while in code mode, and not while watching it', () => {
    function botSetup(mode: 'code' | 'bot') {
      localStorage.clear();
      localStorage.setItem('morse.unread2-bots-seen:single', JSON.stringify({ c1: 100 }));
      const roster = signal({ conversations: [{ id: 'c1', updatedAt: 100 }] });
      const transcripts = signal<Record<string, readonly unknown[]>>({ c1: [{}, {}] });
      const activeId = signal<string | null>('c1');
      const user = signal(null);
      TestBed.configureTestingModule({
        providers: [
          {
            provide: MorseService,
            useValue: {
              user: user as Signal<null>,
              bot: {
                roster: roster as Signal<{ conversations: { id: string; updatedAt: number }[] }>,
                transcripts: transcripts as Signal<Record<string, readonly unknown[]>>,
                activeId: activeId as Signal<string | null>,
              },
            },
          },
        ],
      });
      TestBed.inject(ModePrefs).setMode(mode);
      const unread = TestBed.inject(UnreadBots);
      TestBed.tick();
      return unread;
    }
    // Code mode: the open room is not being read, so its new lines are news.
    expect(botSetup('code').has('c1')).toBe(true);
    TestBed.resetTestingModule();
    // Bot mode, same room in front: the lines arrive on screen, not as news.
    expect(botSetup('bot').has('c1')).toBe(false);
  });

  it('marks only rooms born after the login was last alive', () => {
    const now = Date.now();
    localStorage.clear();
    localStorage.setItem('morse.unread2-bots-seen:single', JSON.stringify({ c1: 100 }));
    localStorage.setItem('morse.unread2-bots-alive:single', JSON.stringify(now - 3_600_000));
    const roster = signal({
      conversations: [
        { id: 'c1', updatedAt: 100 },
        // A room born while the browser was closed: news.
        { id: 'c2', updatedAt: now - 1_800_000 },
        // An old room the cursors never recorded: history, not news.
        { id: 'c3', updatedAt: 50 },
      ],
    });
    const transcripts = signal<Record<string, readonly unknown[]>>({});
    const activeId = signal<string | null>(null);
    const user = signal(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MorseService,
          useValue: {
            user: user as Signal<null>,
            bot: {
              roster: roster as Signal<{ conversations: { id: string; updatedAt: number }[] }>,
              transcripts: transcripts as Signal<Record<string, readonly unknown[]>>,
              activeId: activeId as Signal<string | null>,
            },
          },
        },
      ],
    });
    const unread = TestBed.inject(UnreadBots);
    TestBed.tick();
    expect(unread.has('c1')).toBe(false);
    expect(unread.has('c2')).toBe(true);
    expect(unread.has('c3')).toBe(false);
  });

  it('waits for the roster on a fresh visit instead of marking it', () => {
    localStorage.clear();
    const roster = signal<{ conversations: { id: string; updatedAt: number }[] } | null>(null);
    const transcripts = signal<Record<string, readonly unknown[]>>({});
    const activeId = signal<string | null>(null);
    const user = signal(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MorseService,
          useValue: {
            user: user as Signal<null>,
            bot: {
              roster: roster as Signal<{ conversations: { id: string; updatedAt: number }[] } | null>,
              transcripts: transcripts as Signal<Record<string, readonly unknown[]>>,
              activeId: activeId as Signal<string | null>,
            },
          },
        },
      ],
    });
    const unread = TestBed.inject(UnreadBots);
    TestBed.tick();
    expect(unread.count()).toBe(0);
    roster.set({ conversations: [{ id: 'c1', updatedAt: 100 }] });
    TestBed.tick();
    expect(unread.count()).toBe(0);
  });

  it('marks a room whose round ends before bot mode was ever opened', () => {
    localStorage.clear();
    const roster = signal<{ conversations: { id: string; updatedAt: number }[] } | null>(null);
    const transcripts = signal<Record<string, readonly unknown[]>>({});
    const activeId = signal<string | null>(null);
    const routing = signal<Record<string, { active: string[] }>>({ c1: { active: ['x'] } });
    const user = signal(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MorseService,
          useValue: {
            user: user as Signal<null>,
            bot: {
              roster: roster as Signal<{ conversations: { id: string; updatedAt: number }[] } | null>,
              transcripts: transcripts as Signal<Record<string, readonly unknown[]>>,
              activeId: activeId as Signal<string | null>,
              routing: routing as Signal<Record<string, { active: string[] }>>,
            },
          },
        },
      ],
    });
    const unread = TestBed.inject(UnreadBots);
    TestBed.tick();
    // Seeding the in-flight round is silent.
    expect(unread.count()).toBe(0);
    routing.set({});
    TestBed.tick();
    // The round ended while the reader was in Code mode: news, no visit needed.
    expect(unread.has('c1')).toBe(true);
  });

  it('leaves the watched room quiet when its round ends', () => {
    localStorage.clear();
    const roster = signal<{ conversations: { id: string; updatedAt: number }[] } | null>(null);
    const transcripts = signal<Record<string, readonly unknown[]>>({});
    const activeId = signal<string | null>('c1');
    const routing = signal<Record<string, { active: string[] }>>({ c1: { active: ['x'] } });
    const user = signal(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MorseService,
          useValue: {
            user: user as Signal<null>,
            bot: {
              roster: roster as Signal<{ conversations: { id: string; updatedAt: number }[] } | null>,
              transcripts: transcripts as Signal<Record<string, readonly unknown[]>>,
              activeId: activeId as Signal<string | null>,
              routing: routing as Signal<Record<string, { active: string[] }>>,
            },
          },
        },
      ],
    });
    TestBed.inject(ModePrefs).setMode('bot');
    const unread = TestBed.inject(UnreadBots);
    TestBed.tick();
    routing.set({});
    TestBed.tick();
    expect(unread.has('c1')).toBe(false);
  });

  it('drops dots for deleted conversations', () => {
    localStorage.clear();
    localStorage.setItem('morse.unread2-bots:single', JSON.stringify(['gone']));
    localStorage.setItem('morse.unread2-bots-seen:single', JSON.stringify({ c1: 100 }));
    const roster = signal({ conversations: [{ id: 'c1', updatedAt: 100 }] });
    const transcripts = signal<Record<string, readonly unknown[]>>({});
    const activeId = signal<string | null>(null);
    const user = signal(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MorseService,
          useValue: {
            user: user as Signal<null>,
            bot: {
              roster: roster as Signal<{ conversations: { id: string; updatedAt: number }[] }>,
              transcripts: transcripts as Signal<Record<string, readonly unknown[]>>,
              activeId: activeId as Signal<string | null>,
            },
          },
        },
      ],
    });
    const unread = TestBed.inject(UnreadBots);
    TestBed.tick();
    expect(unread.has('gone')).toBe(false);
    expect(unread.count()).toBe(0);
  });
});
