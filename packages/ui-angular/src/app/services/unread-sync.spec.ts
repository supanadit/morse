import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../host/morse.service';
import { UnreadBots } from '../state/unread-bots';
import { UnreadSessions } from '../state/unread-sessions';
import { UNREAD_VERSION, UnreadSync } from './unread-sync';

function envelope(sessions: string[], bots: string[], version = UNREAD_VERSION) {
  return {
    version,
    data: {
      sessions: { ids: sessions, seen: {}, counts: {}, alive: 0 },
      bots: { ids: bots, seen: {}, lengths: {}, alive: 0 },
    },
  };
}

function setup(stored: unknown = null) {
  localStorage.clear();
  const connection = signal<'connecting' | 'ready'>('connecting');
  const caps = signal<Record<string, unknown> | undefined>(undefined);
  const sessions = signal<{ id: string; updatedAt: number; messageCount?: number }[]>([]);
  const state = signal<{ sessionId?: string }>({});
  const activity = signal(new Map<string, { streaming: boolean }>());
  const user = signal(null);
  const saved: { version: number; data: unknown }[] = [];
  const fake = {
    connection: connection as Signal<'connecting' | 'ready'>,
    capabilities: caps as Signal<Record<string, unknown> | undefined>,
    sessions: sessions as Signal<{ id: string; updatedAt: number }[]>,
    state,
    sessionActivity: activity,
    user,
    sessionsLoaded: signal(true),
    sessionHasMore: signal({}),
    hostEpoch: signal(1),
    requestSessions: vi.fn(),
    requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'readUnread') return Promise.resolve(stored);
      if (command === 'saveUnread') {
        saved.push(args as { version: number; data: unknown });
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
  TestBed.inject(UnreadSync);
  return { fake, connection, caps, saved, sessions };
}

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('UnreadSync', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('adopts the host marks, not the ones left in this browser', async () => {
    localStorage.setItem('morse.unread2-finished:single', JSON.stringify(['local']));
    const { fake, connection, caps } = setup(envelope(['remote-session'], ['remote-room']));

    caps.set({ workbench: true });
    connection.set('ready');
    TestBed.tick();
    await settled();

    expect(fake.requestHostCommand).toHaveBeenCalledWith('readUnread');
    const unreadSessions = TestBed.inject(UnreadSessions);
    const unreadBots = TestBed.inject(UnreadBots);
    expect(unreadSessions.has('remote-session')).toBe(true);
    expect(unreadSessions.has('local')).toBe(false);
    expect(unreadBots.has('remote-room')).toBe(true);
  });

  it('writes new marks back to the host so other devices see them', async () => {
    const { connection, caps, saved } = setup();
    caps.set({ workbench: true });
    connection.set('ready');
    TestBed.tick();
    await settled();

    const unreadSessions = TestBed.inject(UnreadSessions);
    unreadSessions.mark(['new-session']);
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(saved).toHaveLength(1);
    expect(saved[0]!.version).toBe(UNREAD_VERSION);
    const data = saved[0]!.data as { sessions: { ids: string[] } };
    expect(data.sessions.ids).toContain('new-session');
  });

  it('ignores a save from a frontend build it cannot read', async () => {
    const { connection, caps, fake } = setup(envelope(['old'], [], UNREAD_VERSION + 1));
    caps.set({ workbench: true });
    connection.set('ready');
    TestBed.tick();
    await settled();

    expect(TestBed.inject(UnreadSessions).has('old')).toBe(false);
    expect(fake.requestHostCommand).not.toHaveBeenCalledWith('saveUnread', expect.anything());
  });
});
