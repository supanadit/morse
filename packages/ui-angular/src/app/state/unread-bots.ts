import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { MorseService } from '../host/morse.service';
import { ModePrefs } from './mode-prefs';

function idsKey(scope: string): string {
  return `morse.unread2-bots:${scope}`;
}

function seenKey(scope: string): string {
  return `morse.unread2-bots-seen:${scope}`;
}

/** Wall-clock the scope was last alive, for telling new rooms from old ones. */
function aliveKey(scope: string): string {
  return `morse.unread2-bots-alive:${scope}`;
}

/** Transcript lengths already read, so a reload cannot mistake old lines for new. */
function lengthsKey(scope: string): string {
  return `morse.unread2-bots-lengths:${scope}`;
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

/** Same validation as a stored map, for state that arrived over the wire. */
function asNumberMap(value: unknown): Map<string, number> {
  if (typeof value !== 'object' || value === null) return new Map();
  const map = new Map<string, number>();
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === 'number') map.set(id, at);
  }
  return map;
}

function readLengths(key: string): Map<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return new Map();
    const map = new Map<string, number>();
    for (const [id, len] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof len === 'number') map.set(id, len);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** The whole read state, as the host stores it for every device. */
export interface BotUnreadData {
  ids: string[];
  seen: Record<string, number>;
  lengths: Record<string, number>;
  alive: number;
}

interface ConversationRow {
  id: string;
  updatedAt: number;
}

/**
 * Bot conversations with lines the reader has not opened. Two paths, like
 * sessions: live transcript growth in a background room marks it at once, and
 * a per-conversation `updatedAt` cursor catches up whatever moved while the
 * browser was closed or another tab was in front.
 *
 * Cleared one id at a time when its conversation comes into front. Same
 * no-leak contract as sessions: keys carry the login id, a scope with no
 * record waits for its own roster before seeding, the roster is always whole
 * so dots naming nothing in it are dropped, and a roster that has not arrived
 * yet reconciles nothing.
 */
@Injectable({ providedIn: 'root' })
export class UnreadBots {
  private readonly morse = inject(MorseService);
  private readonly modes = inject(ModePrefs);
  private readonly idsSignal = signal<Set<string>>(new Set());
  readonly ids = this.idsSignal.asReadonly();
  readonly count = (): number => this.idsSignal().size;
  /** Transcript lengths already seen, so only growth is news. */
  private lengths = new Map<string, number>();
  /** Round ids in flight at the last report; `null` until the first one. */
  private rounds: Set<string> | null = null;
  /** Last `updatedAt` observed per conversation, for closed-browser catch-up. */
  private seen = new Map<string, number>();
  /** When this login was last alive; new rooms are born after this. */
  private alive = 0;
  /** Scopes whose initial handling is done (seeded or caught up). */
  private ready = new Set<string>();
  private scope = '';
  /** True when the scope's stored record existed at load (a returning reader). */
  private returning = false;

  /** hostEpoch values a roster was already requested for; a reconnect re-asks. */
  private listedFor: unknown = null;

  constructor() {
    effect(() => {
      // Rounds are the live signal: they end whether or not this client ever
      // opened the room, so a reply landing while the reader is in Code mode —
      // or before Bot mode was ever opened — still marks its room. The roster
      // is only republished on mutations, never on a new message.
      const routing = this.routingKeys();
      const roster = this.roster();
      // Nobody asks for a roster until Bot mode renders, so a reader who never
      // leaves Code mode would never learn a room exists. Ask once per
      // connection instead — the reply is what catch-up reconciles.
      if (roster === null && this.botCapable()) {
        const epoch = this.hostEpoch();
        if (this.listedFor !== epoch) {
          this.listedFor = epoch;
          untracked(() => this.requestRoster());
        }
      }
      const transcripts = this.transcriptLengths();
      const active = this.activeId();
      const scope = this.scopeId();
      if (roster === null) {
        untracked(() => this.watchRounds(routing, active, scope));
        return;
      }
      untracked(() => {
        this.watchRounds(routing, active, scope);
        this.reconcile(roster, transcripts, active, scope);
      });
    });
    globalThis.addEventListener?.('storage', (event: StorageEvent) => {
      if (event.key !== idsKey(this.scope) && event.key !== seenKey(this.scope)) return;
      untracked(() => this.reload());
    });
  }

  has(id: string): boolean {
    return this.idsSignal().has(id);
  }

  snapshot(): BotUnreadData {
    return {
      ids: [...this.idsSignal()],
      seen: Object.fromEntries(this.seen),
      lengths: Object.fromEntries(this.lengths),
      alive: this.alive,
    };
  }

  /** Adopts another device's read state; the local cache follows so tabs agree. */
  restore(data: BotUnreadData): void {
    this.idsSignal.set(new Set(Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === 'string') : []));
    this.seen = asNumberMap(data.seen);
    this.lengths = asNumberMap(data.lengths);
    this.alive = typeof data.alive === 'number' ? data.alive : 0;
    this.returning = this.seen.size > 0;
    this.storeIds();
    this.storeSeen();
  }

  /** Marks background rooms unread; the reconciler is the real caller. */
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

  /** Opens one room: its dot goes, and its cursor catches up so it stays gone. */
  clear(id: string): void {
    this.ensureScope(this.scopeId());
    const at = this.roster()?.find((conversation) => conversation.id === id)?.updatedAt;
    if (at !== undefined) this.seen.set(id, at);
    const lines = this.transcriptLengths().get(id);
    if (lines !== undefined) this.lengths.set(id, lines);
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

  /**
   * Marks rooms whose round just ended anywhere else. A round ending in the
   * room on screen (Bot mode, that room in front) is being read, not news.
   */
  private watchRounds(routing: ReadonlySet<string>, active: string | null, scope: string): void {
    if (this.rounds === null) {
      this.rounds = new Set(routing);
      return;
    }
    this.ensureScope(scope);
    let changed = false;
    const unread = new Set(this.idsSignal());
    for (const id of this.rounds) {
      if (routing.has(id) || id === active || unread.has(id)) continue;
      unread.add(id);
      changed = true;
    }
    this.rounds = new Set(routing);
    if (!changed) return;
    this.idsSignal.set(unread);
    this.storeIds();
  }

  private reconcile(
    conversations: ConversationRow[],
    transcripts: ReadonlyMap<string, number>,
    active: string | null,
    scope: string,
  ): void {
    this.ensureScope(scope);
    if (!this.ready.has(scope)) {
      if (!this.returning) {
        // Same rule as sessions: wait for this login's own roster before
        // seeding, so another login's rooms never become this login's unread.
        if (conversations.length === 0) return;
        for (const conversation of conversations) {
          this.seen.set(conversation.id, conversation.updatedAt);
        }
        for (const [id, len] of transcripts) this.lengths.set(id, len);
        this.alive = Date.now();
        this.ready.add(scope);
        this.storeSeen();
        return;
      }
      this.ready.add(scope);
    }
    // The horizon for "now and future" — read before moving it.
    const horizon = this.alive - GRACE_MS;
    this.alive = Date.now();
    let changed = false;
    const unread = new Set(this.idsSignal());
    const listed = new Set<string>();
    for (const conversation of conversations) {
      listed.add(conversation.id);
      if (conversation.id === active) {
        this.seen.set(conversation.id, conversation.updatedAt);
        const len = transcripts.get(conversation.id);
        if (len !== undefined) this.lengths.set(conversation.id, len);
        if (unread.delete(conversation.id)) changed = true;
        continue;
      }
      const at = this.seen.get(conversation.id);
      if (at === undefined) {
        this.seen.set(conversation.id, conversation.updatedAt);
        const len = transcripts.get(conversation.id);
        if (len !== undefined) this.lengths.set(conversation.id, len);
        // A room that appeared with lines already in it arrived while away —
        // but only when it was born after the login was last alive. Old rooms
        // the cursors simply never recorded are history, not news.
        if (
          conversation.updatedAt > horizon &&
          !unread.has(conversation.id)
        ) {
          unread.add(conversation.id);
          changed = true;
        }
        continue;
      }
      const len = transcripts.get(conversation.id) ?? this.lengths.get(conversation.id) ?? 0;
      const grew = len > (this.lengths.get(conversation.id) ?? 0);
      this.lengths.set(conversation.id, len);
      if (conversation.updatedAt > at || grew) {
        this.seen.set(conversation.id, conversation.updatedAt);
        if (!unread.has(conversation.id)) {
          unread.add(conversation.id);
          changed = true;
        }
      }
    }
    // The roster is always whole (unlike the paged session catalog), so a dot
    // naming nothing in it is a deleted conversation, not an unloaded page.
    for (const id of unread) {
      if (!listed.has(id)) {
        unread.delete(id);
        changed = true;
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
    this.lengths = readLengths(lengthsKey(scope));
    this.idsSignal.set(readIds(idsKey(scope)));
    this.alive = readAlive(aliveKey(scope));
    // Cursors mean a previous reconcile ran here; bare ids alone are live
    // marks with no baseline, and seed silently like a fresh scope.
    this.returning = this.seen.size > 0;
  }

  private reload(): void {
    this.seen = readSeen(seenKey(this.scope));
    this.lengths = readLengths(lengthsKey(this.scope));
    this.idsSignal.set(readIds(idsKey(this.scope)));
    this.alive = readAlive(aliveKey(this.scope));
    this.returning = this.seen.size > 0;
  }

  private storeIds(): void {
    try {
      globalThis.localStorage?.setItem(idsKey(this.scope), JSON.stringify([...this.idsSignal()]));
    } catch {
      // Same as sessions: dots still work for the visit.
    }
  }

  private storeSeen(): void {
    try {
      const entries = [...this.seen];
      const kept = entries.slice(Math.max(0, entries.length - 2000));
      const lengths = [...this.lengths].slice(Math.max(0, this.lengths.size - 2000));
      globalThis.localStorage?.setItem(seenKey(this.scope), JSON.stringify(Object.fromEntries(kept)));
      globalThis.localStorage?.setItem(aliveKey(this.scope), JSON.stringify(this.alive));
      globalThis.localStorage?.setItem(lengthsKey(this.scope), JSON.stringify(Object.fromEntries(lengths)));
    } catch {
      // As above.
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

  /** Rooms with a round in flight right now. */
  private routingKeys(): ReadonlySet<string> {
    try {
      const routing = (
        this.morse as { bot?: { routing?: () => Record<string, unknown> } }
      ).bot?.routing?.();
      return new Set(Object.keys(routing ?? {}));
    } catch {
      return new Set();
    }
  }

  /** Whether this host runs bot mode at all; elsewhere there is no roster. */
  private botCapable(): boolean {
    try {
      return (
        (this.morse as { capabilities?: () => { bot?: boolean } | null }).capabilities?.()
          ?.bot === true
      );
    } catch {
      return false;
    }
  }

  private hostEpoch(): unknown {
    try {
      return (this.morse as { hostEpoch?: () => unknown }).hostEpoch?.();
    } catch {
      return undefined;
    }
  }

  private requestRoster(): void {
    try {
      (this.morse as { listBots?: () => void }).listBots?.();
    } catch {
      // The wire will be there on the next connection; rounds still mark.
    }
  }

  /** `null` until the first roster push — reconciling against "no rooms" would prune real dots. */
  private roster(): ConversationRow[] | null {
    try {
      const roster = (
        this.morse as { bot?: { roster?: () => { conversations?: ConversationRow[] } | null } }
      ).bot?.roster?.();
      if (roster === null || roster === undefined) return null;
      return roster.conversations ?? [];
    } catch {
      return [];
    }
  }

  private transcriptLengths(): ReadonlyMap<string, number> {
    try {
      const transcripts = (
        this.morse as { bot?: { transcripts?: () => Record<string, readonly unknown[]> } }
      ).bot?.transcripts?.();
      const lengths = new Map<string, number>();
      for (const [id, lines] of Object.entries(transcripts ?? {})) {
        lengths.set(id, lines.length);
      }
      return lengths;
    } catch {
      return new Map();
    }
  }

  private activeId(): string | null {
    try {
      // Mirror of sessions: the open room only counts as read in Bot mode.
      if (this.modes.mode() !== 'bot') return null;
      return (
        (this.morse as { bot?: { activeId?: () => string | null } }).bot?.activeId?.() ?? null
      );
    } catch {
      return null;
    }
  }
}
