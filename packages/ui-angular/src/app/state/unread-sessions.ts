import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { MorseService } from '../host/morse.service';
import { ModePrefs } from './mode-prefs';

function idsKey(scope: string): string {
  return `morse.unread2-finished:${scope}`;
}

function seenKey(scope: string): string {
  return `morse.unread2-finished-seen:${scope}`;
}

/** Wall-clock the scope was last alive, for telling new rows from old pages. */
function aliveKey(scope: string): string {
  return `morse.unread2-alive:${scope}`;
}

function readAlive(key: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw === null ? 0 : JSON.parse(raw);
    return typeof parsed === 'number' ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Clock skew between the browser and the host stays well under this. */
const GRACE_MS = 60_000;

function readIds(key: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function readSeen(key: string): Map<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return new Map();
    const map = new Map<string, number>();
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number') map.set(id, at);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Sessions that finished while the reader was elsewhere — including while the
 * browser was closed. Two paths feed the same set:
 *
 * - live: `RunNotifier` marks a finish the moment streaming stops;
 * - catch-up: the session list is reconciled against a per-session
 *   `updatedAt` cursor, so anything that moved while the page was gone (or in
 *   another tab) becomes unread on return.
 *
 * Cleared one id at a time when its session comes into front — opening one
 * session never clears another. Tabs in other windows follow through the
 * `storage` event.
 *
 * No leaks across logins: the keys carry the login id (`user.id`, `'single'`
 * on single-user hosts), login/logout reloads the page, a scope with no
 * record waits for its own list before seeding (so one login's catalog never
 * becomes another's unread), and ids for sessions the catalog no longer holds
 * are dropped once the catalog is fully loaded.
 */
@Injectable({ providedIn: 'root' })
export class UnreadSessions {
  private readonly morse = inject(MorseService);
  private readonly modes = inject(ModePrefs);
  private readonly idsSignal = signal<Set<string>>(new Set());
  readonly ids = this.idsSignal.asReadonly();
  /** Last `updatedAt` observed per session; growth outside the active one is news. */
  private seen = new Map<string, number>();
  /** When this login was last alive; new rows are newer than this (give or take skew). */
  private alive = 0;
  /** Scopes whose initial handling is done (seeded or caught up). */
  private ready = new Set<string>();
  private scope = '';
  /** True when the scope's stored record existed at load (a returning reader). */
  private returning = false;

  constructor() {
    effect(() => {
      const sessions = this.sessions();
      const active = this.activeId();
      const streaming = this.streamingIds();
      const scope = this.scopeId();
      untracked(() => this.reconcile(sessions, active, streaming, scope));
    });
    globalThis.addEventListener?.('storage', (event: StorageEvent) => {
      if (event.key !== idsKey(this.scope) && event.key !== seenKey(this.scope)) return;
      untracked(() => this.reload());
    });
  }

  has(id: string): boolean {
    return this.idsSignal().has(id);
  }

  /** Marks live finishes; the reconciler owns everything list-driven. */
  mark(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.ensureScope(this.scopeId());
    let changed = false;
    const next = new Set(this.idsSignal());
    for (const id of ids) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (!changed) return;
    this.idsSignal.set(next);
    this.storeIds();
  }

  /** Opens one session: its dot goes, and its cursor catches up so it stays gone. */
  clear(id: string): void {
    this.ensureScope(this.scopeId());
    const at = this.sessions().find((session) => session.id === id)?.updatedAt;
    if (at !== undefined) this.seen.set(id, at);
    if (!this.idsSignal().has(id)) {
      this.storeSeen();
      return;
    }
    this.idsSignal.update((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    this.storeIds();
    this.storeSeen();
  }

  private reconcile(
    sessions: { id: string; updatedAt: number }[],
    active: string | undefined,
    streaming: ReadonlySet<string>,
    scope: string,
  ): void {
    this.ensureScope(scope);
    if (!this.ready.has(scope)) {
      if (!this.returning) {
        // No record for this login: a fresh browser, not a returning reader.
        // Wait for its own list — seeding (or marking) an empty or another
        // login's catalog would leak it into this login's dots.
        if (sessions.length === 0) return;
        for (const session of sessions) this.seen.set(session.id, session.updatedAt);
        this.alive = Date.now();
        this.ready.add(scope);
        this.storeSeen();
        return;
      }
      this.ready.add(scope);
    }
    // The horizon for "now and future": rows born after the login was last
    // alive. Read before moving it — the stored value is the away window.
    const horizon = this.alive - GRACE_MS;
    this.alive = Date.now();
    let changed = false;
    const unread = new Set(this.idsSignal());
    const listed = new Set<string>();
    for (const session of sessions) {
      listed.add(session.id);
      if (session.id === active) {
        this.seen.set(session.id, session.updatedAt);
        if (unread.delete(session.id)) changed = true;
        continue;
      }
      const at = this.seen.get(session.id);
      if (at === undefined) {
        // Unknown rows arrive two ways: genuinely new sessions (news), and old
        // sessions on a page the catalog just loaded (not news). The birth
        // date tells them apart — only "now and future" marks.
        this.seen.set(session.id, session.updatedAt);
        if (
          session.updatedAt > horizon &&
          !streaming.has(session.id) &&
          !unread.has(session.id)
        ) {
          unread.add(session.id);
          changed = true;
        }
        continue;
      }
      if (session.updatedAt <= at) continue;
      this.seen.set(session.id, session.updatedAt);
      if (!streaming.has(session.id) && !unread.has(session.id)) {
        unread.add(session.id);
        changed = true;
      }
    }
    // Fully loaded and a dot names nothing in it: the session is gone
    // (deleted elsewhere), so the dot goes too instead of inflating the count.
    // A paged catalog never prunes — an unloaded page is not a deletion.
    if (this.catalogComplete()) {
      for (const id of unread) {
        if (!listed.has(id)) {
          unread.delete(id);
          changed = true;
        }
      }
    }
    if (!changed) {
      this.storeSeen();
      return;
    }
    this.idsSignal.set(unread);
    this.storeIds();
    this.storeSeen();
  }

  /** Loads a scope's record; logins never share buckets. */
  private ensureScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.seen = readSeen(seenKey(scope));
    this.idsSignal.set(readIds(idsKey(scope)));
    this.alive = readAlive(aliveKey(scope));
    // Cursors mean a previous reconcile ran here; bare ids alone are live
    // marks with no baseline, and seed silently like a fresh scope.
    this.returning = this.seen.size > 0;
  }

  private reload(): void {
    this.seen = readSeen(seenKey(this.scope));
    this.idsSignal.set(readIds(idsKey(this.scope)));
    this.alive = readAlive(aliveKey(this.scope));
    this.returning = this.seen.size > 0;
  }

  private storeIds(): void {
    try {
      globalThis.localStorage?.setItem(idsKey(this.scope), JSON.stringify([...this.idsSignal()]));
    } catch {
      // Storage unavailable (private mode): the dots still work for the visit.
    }
  }

  private storeSeen(): void {
    try {
      // Bounded: a catalog that paged away must not lose its cursors, but an
      // ever-growing map must not either — the oldest go first.
      const entries = [...this.seen];
      const kept = entries.slice(Math.max(0, entries.length - 2000));
      globalThis.localStorage?.setItem(seenKey(this.scope), JSON.stringify(Object.fromEntries(kept)));
      globalThis.localStorage?.setItem(aliveKey(this.scope), JSON.stringify(this.alive));
    } catch {
      // As above.
    }
  }

  /** The catalog is whole: loaded, with no project holding a further page. */
  private catalogComplete(): boolean {
    try {
      const shell = this.morse as {
        sessionsLoaded?: () => boolean;
        sessionHasMore?: () => Record<string, boolean>;
      };
      if (shell.sessionsLoaded?.() !== true) return false;
      const hasMore = shell.sessionHasMore?.();
      if (hasMore === undefined) return false;
      return Object.values(hasMore).every((more) => more === false);
    } catch {
      return false;
    }
  }

  private scopeId(): string {
    try {
      return (
        (this.morse as { user?: () => { id?: string } | null }).user?.()?.id ?? 'single'
      );
    } catch {
      return 'single';
    }
  }

  private sessions(): { id: string; updatedAt: number }[] {
    try {
      return (this.morse as { sessions?: () => { id: string; updatedAt: number }[] }).sessions?.() ?? [];
    } catch {
      return [];
    }
  }

  private activeId(): string | undefined {
    try {
      // The front session is only "being read" in Code mode; in Bot mode the
      // reader cannot see it, so its finishes are news like any other's.
      if (this.modes.mode() !== 'code') return undefined;
      return (this.morse as { state?: () => { sessionId?: string } }).state?.()?.sessionId;
    } catch {
      return undefined;
    }
  }

  private streamingIds(): ReadonlySet<string> {
    try {
      const activity = (
        this.morse as { sessionActivity?: () => Map<string, { streaming: boolean }> }
      ).sessionActivity?.();
      const ids = new Set<string>();
      for (const [id, entry] of activity ?? []) {
        if (entry.streaming) ids.add(id);
      }
      return ids;
    } catch {
      return new Set();
    }
  }
}
