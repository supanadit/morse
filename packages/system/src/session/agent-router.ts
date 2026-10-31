import type {
  AgentChildSessionRef,
  AgentEvent,
  AgentGateway,
  AgentGatewayFactory,
  AgentSessionState,
  ModelRef,
  SessionEngine,
  WorkspaceRef,
} from '@morse/agent';
import type { SessionSummary } from '../domain/index.js';
import { AgentUnavailableError, UnsupportedByHostError } from '../errors.js';
import type { MorseLogger } from '../logger.js';
import { deriveSessionId } from './identity.js';
import type { AgentExtras } from './integration.js';
import {
  DEFAULT_SESSION_SEARCH_LIMIT,
  DEFAULT_SESSIONS_PER_PROJECT,
  type SessionCatalog,
  type SessionPage,
  type SessionStore,
} from './ports.js';
import { reconcileSessions } from './reconcile.js';
import { toSessionSummary, UNTITLED_SESSION, type MorseSessionRecord } from './record.js';

/**
 * The engine router: how Morse addresses a session by its own id no matter which
 * harness created it, and how the sidebar is served from Morse's index instead
 * of any engine's files.
 *
 * It is an `AgentGatewayFactory` (so hosts can hand it wherever a factory was
 * expected) and a `SessionCatalog` (so the sidebar reads Morse's index). Every
 * gateway it returns is a `RoutedGateway`, whose state and events name the
 * session by the Morse-derived id — `SessionRegistry` keeps keying by
 * `state.sessionId` and no longer has to know that the id is Morse's — with the
 * engine's own id kept alongside as `engineSessionId`.
 */

/** How long a refresh counts as current, so a busy sidebar does not scan on each read. */
const DEFAULT_FRESH_MS = 15_000;

export interface AgentRouterDeps {
  store: SessionStore;
  /** Workspace for sessions started without an explicit project. */
  defaultWorkspace: WorkspaceRef;
  logger: MorseLogger;
  /** How long a fresh index is trusted before an open re-reads the engines. */
  freshMs?: number;
}

/** One engine a host can start, as the frontend's picker names it. */
export interface EngineDescriptor {
  kind: string;
  label: string;
  /** True for the engine new sessions start in when the draft names none. */
  default?: boolean;
}

export interface AgentRouterRegistration {
  /** Marks this engine as the one new sessions go to. The first registered wins by default. */
  default?: boolean;
  /** The display label; defaults to the kind when a host does not name one. */
  label?: string;
  /**
   * The engine's own catalog, when it keeps conversations Morse may delete.
   * Only the delete path needs it: listing is served from the index, so a
   * catalog that cannot delete simply leaves its rows without a Morse-side
   * "remove".
   */
  catalog?: SessionCatalog;
  /** The engine's own administration (MCP, prompts, version, CLI), when it has any. */
  extras?: AgentExtras;
}

export class AgentRouter implements AgentGatewayFactory, SessionCatalog {
  private readonly engines = new Map<
    string,
    {
      engine: SessionEngine;
      label: string;
      catalog?: SessionCatalog;
      extras?: AgentExtras;
    }
  >();
  private defaultKind: string | undefined;
  /** Morse ids of the sessions this process is running right now. */
  private readonly running = new Set<string>();
  /** A refresh in flight, so concurrent callers share one scan burst. */
  private refreshing: Promise<void> | undefined;
  private lastFresh = 0;
  private readonly freshMs: number;

  constructor(private readonly deps: AgentRouterDeps) {
    this.freshMs = deps.freshMs ?? DEFAULT_FRESH_MS;
  }

  /** Puts an engine on the map: `create` can now reach its factory by kind. */
  register(engine: SessionEngine, options: AgentRouterRegistration = {}): void {
    this.engines.set(engine.kind, {
      engine,
      label: options.label?.trim() || engine.kind,
      catalog: options.catalog,
      extras: options.extras,
    });
    if (this.defaultKind === undefined || options.default === true) {
      this.defaultKind = engine.kind;
    }
  }

  engineFor(kind: string): SessionEngine | undefined {
    return this.engines.get(kind)?.engine;
  }

  /** Every registered engine, for a registry that reconciles them. */
  registeredEngines(): SessionEngine[] {
    return [...this.engines.values()].map((entry) => entry.engine);
  }

  /**
   * The engines a frontend may choose between: kind, label, and which one new
   * sessions start in. Registration order is kept so the list is stable.
   */
  engineOptions(): EngineDescriptor[] {
    return [...this.engines.entries()].map(([kind, entry]) => ({
      kind,
      label: entry.label,
      ...(kind === this.defaultKind ? { default: true } : {}),
    }));
  }

  /** The kind new sessions start in, when an engine is registered. */
  get defaultEngineKind(): string | undefined {
    return this.defaultKind;
  }

  /**
   * The new-session default engine's administration, which is what the host's
   * MCP/prompt editors and update notice must speak for. Undefined when that
   * engine has none (OpenCode) — the host then hides those affordances.
   */
  defaultExtras(): AgentExtras | undefined {
    return this.defaultKind === undefined ? undefined : this.engines.get(this.defaultKind)?.extras;
  }

  /**
   * One engine's administration by kind, for host commands that name their
   * engine (`mcpStatus` & co. carry `engine`). Undefined for an unknown kind or
   * an engine without administration — the host then refuses, it never falls
   * back to another engine's config.
   */
  extrasFor(kind: string): AgentExtras | undefined {
    return this.engines.get(kind)?.extras;
  }

  /**
   * The engine new sessions go to, for hosts that still need it as a concrete
   * engine (pi's MCP administration, say, until the capability ports land).
   * Undefined while no engine is registered as the default.
   */
  get defaultEngine(): SessionEngine | undefined {
    return this.defaultKind === undefined ? undefined : this.engines.get(this.defaultKind)?.engine;
  }

  // ---------------------------------------------------------------- factory

  /**
   * Opens a session for a workspace: reattaching to the engine session a
   * persisted record names, or asking the default engine for a new one.
   *
   * A Morse id unknown to the index after a refresh names a conversation
   * nothing here can open, which is a reported failure — other sessions are
   * untouched.
   */
  async create(options: {
    workspace?: WorkspaceRef;
    sessionId?: string;
    /** The engine a new session should start in; omitted means the default. */
    engine?: string;
    /** The mode a new session should start in, when the caller chose one. */
    mode?: string;
  }): Promise<AgentGateway> {
    if (options.sessionId !== undefined) {
      await this.ensureFresh();
      let record = await this.deps.store.read(options.sessionId);
      if (record === undefined) {
        // Not found in an index that may simply be a few seconds old: a session
        // started mid-run (a subagent's child, most often) is in the engine's
        // listing before any scan has read it, and the debounce would happily
        // answer "unknown" for the rest of the window. One forced scan settles
        // it; only a session no engine reports is really missing.
        await this.ensureFresh(true);
        record = await this.deps.store.read(options.sessionId);
      }
      if (record === undefined) {
        throw new AgentUnavailableError(`No session for ${options.sessionId} is in the index.`);
      }
      const registered = this.engines.get(record.engineRef.engine);
      if (registered === undefined) {
        throw new AgentUnavailableError(
          `Session ${record.id} belongs to ${record.engineRef.engine}, which is not installed here.`,
        );
      }
      const inner = await registered.engine.factory.create({
        workspace: { cwd: record.cwd, name: baseName(record.cwd) },
        sessionId: record.engineRef.sessionId,
      });
      // Resume keeps the record's engine: the default may be a different one now.
      return this.route(inner, { record, kind: record.engineRef.engine });
    }

    const workspace = options.workspace ?? this.deps.defaultWorkspace;
    const kind = options.engine ?? this.defaultKind;
    if (kind === undefined) {
      throw new UnsupportedByHostError(
        'No agent engine is registered, so a new session cannot start.',
      );
    }
    const registered = this.engines.get(kind);
    if (registered === undefined) {
      throw new AgentUnavailableError(
        options.engine === undefined
          ? `The default engine ${kind} is not registered.`
          : `The ${kind} engine is not installed here.`,
      );
    }
    const inner = await registered.engine.factory.create({
      workspace,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    // Stamp the engine whose factory produced this session, never the default.
    return this.route(inner, { cwd: workspace.cwd, kind });
  }

  /**
   * A never-recording gateway, for hosts that probe what the backend offers
   * before any session exists. It is *not* routed: a probe never becomes a
   * session, so there is no id to wrap and nothing may touch the index.
   */
  async probeDefaults(options: {
    workspace?: WorkspaceRef;
    engine?: string;
    model?: ModelRef;
  }): Promise<AgentGateway> {
    await this.ensureFresh();
    const engine =
      options.engine === undefined ? this.defaultEngine : this.engineFor(options.engine);
    if (engine === undefined) {
      throw new AgentUnavailableError(
        options.engine === undefined
          ? 'No engine is registered as the default, so a draft cannot be probed.'
          : `The ${options.engine} engine is not installed here.`,
      );
    }
    const probe = engine.factory.probeDefaults;
    if (probe === undefined) {
      throw new UnsupportedByHostError(
        `The ${engine.kind} engine does not offer a session-less probe.`,
      );
    }
    return await probe.call(engine.factory, {
      workspace: options.workspace ?? this.deps.defaultWorkspace,
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
  }

  // ---------------------------------------------------------------- catalog

  /** Each project's first page of sessions, merged from the index. */
  async list(): Promise<SessionSummary[]> {
    await this.ensureFresh();
    const records = await this.deps.store.list();
    const perProject = new Map<string, number>();
    return sortedByRecency(records)
      .filter((record) => {
        const seen = perProject.get(record.cwd) ?? 0;
        perProject.set(record.cwd, seen + 1);
        // Capped so a huge project does not make the first paint read all of it;
        // `listPage` fetches the rest on demand.
        return seen < DEFAULT_SESSIONS_PER_PROJECT;
      })
      .map(toSessionSummary);
  }

  /** More of one project's sessions, for the sidebar's "Load more" row. */
  async listPage(options: { cwd: string; offset?: number; limit?: number }): Promise<SessionPage> {
    await this.ensureFresh(true);
    const records = sortedByRecency(await this.deps.store.list()).filter(
      (record) => record.cwd === options.cwd,
    );
    const start = options.offset ?? DEFAULT_SESSIONS_PER_PROJECT;
    const limit = options.limit ?? DEFAULT_SESSIONS_PER_PROJECT;
    return {
      sessions: records.slice(start, start + limit).map(toSessionSummary),
      hasMore: start + limit < records.length,
    };
  }

  /** Sessions whose title or project path contains the query, capped to a ceiling. */
  async search(
    query: string,
    limit: number = DEFAULT_SESSION_SEARCH_LIMIT,
  ): Promise<SessionSummary[]> {
    await this.ensureFresh(true);
    const needle = query.toLowerCase();
    return sortedByRecency(await this.deps.store.list())
      .filter(
        (record) =>
          record.title.toLowerCase().includes(needle) || record.cwd.toLowerCase().includes(needle),
      )
      .slice(0, limit)
      .map(toSessionSummary);
  }

  /** True number of stored sessions per project path — no cap, no engine read. */
  async countByProject(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const record of await this.deps.store.list()) {
      counts.set(record.cwd, (counts.get(record.cwd) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Deletes one session: the engine that owns its conversation first, then the
   * index row. A delete the engine refuses leaves the index alone, so the row
   * never lists a conversation that still opens.
   */
  async remove(id: string): Promise<void> {
    const record = await this.deps.store.read(id);
    if (record === undefined) {
      return; // Already gone is exactly what a delete asked for.
    }
    const registered = this.engines.get(record.engineRef.engine);
    if (registered !== undefined) {
      const remove = registered.catalog?.remove;
      if (remove === undefined) {
        throw new UnsupportedByHostError(
          `Sessions of ${record.engineRef.engine} cannot be deleted from Morse.`,
        );
      }
      await remove.call(registered.catalog, record.engineRef.sessionId);
    }
    await this.deps.store.remove?.(id);
    this.lastFresh = 0; // A delete must not be papered over by a stale window.
  }

  // ---------------------------------------------------------------- reconcile

  /**
   * Refreshes the index from every engine that can report, debounced and
   * guarded: one scan burst at a time, and reads inside the window share the
   * previous result without touching an engine again.
   *
   * An engine that cannot be read never erases its rows — its scan is skipped
   * and the index serves what it holds, so an engine being down never looks
   * like an index of deleted sessions.
   */
  async ensureFresh(force = false): Promise<void> {
    if (this.refreshing !== undefined) {
      return this.refreshing;
    }
    if (!force && Date.now() - this.lastFresh < this.freshMs) {
      return;
    }
    const burst: Promise<void> = this.runScans();
    this.refreshing = burst;
    // The burst never rejects (each engine's scan is caught inside), so the
    // cleanup is only about letting the *next* burst start.
    void burst.finally(() => {
      if (this.refreshing === burst) {
        this.refreshing = undefined;
      }
    });
    // `lastFresh` is set even on a partial refresh: an engine that cannot be
    // read should not turn every later read into a repeat scan.
    await burst;
    this.lastFresh = Date.now();
  }

  /**
   * Reconciles each engine's report against the index, scoped to its own rows:
   * one engine failing does not prevent another from being merged, and one that
   * fails never has its rows removed by a report it never gave.
   *
   * Sessions this process is running are protected: a report that does not
   * mention one is treated as stale (its file may still be mid-write), so a
   * running conversation is never erased from the sidebar.
   */
  private async runScans(): Promise<void> {
    for (const [kind, { engine }] of this.engines) {
      const scan = engine.scan;
      if (scan === undefined) {
        continue;
      }
      try {
        await reconcileSessions({
          kind,
          // Bound, so an adapter's `scan` keeps its `this` when it is a method.
          scan: () => scan.call(engine),
          store: this.deps.store,
          running: this.running,
        });
      } catch (error: unknown) {
        this.deps.logger.warn(`Could not reconcile ${kind} sessions into the index`, error);
      }
    }
  }

  // ---------------------------------------------------------------- internals

  /** Wraps a gateway so its id becomes Morse's, in its own state and events. */
  private route(
    inner: AgentGateway,
    options: {
      cwd?: string;
      /** The harness kind whose factory produced `inner` — the record's on resume. */
      kind: string;
      /** The persisted record, when this resumes one. */
      record?: MorseSessionRecord;
    },
  ): AgentGateway {
    const record = options.record;
    return new RoutedGateway({
      inner,
      kind: options.kind,
      cwd: record?.cwd ?? options.cwd ?? this.deps.defaultWorkspace.cwd,
      store: this.deps.store,
      logger: this.deps.logger,
      ...(record === undefined ? {} : { record }),
      // The running set is what protects a live row from a stale report: it
      // follows the gateway's id through a fork and leaves when it is disposed.
      onIdChange: (previous, next) => {
        if (previous !== undefined) {
          this.running.delete(previous);
        }
        if (next !== undefined) {
          this.running.add(next);
        }
      },
    });
  }
}

/** What a `RoutedGateway` needs to turn a harness gateway into a Morse session. */
interface RoutedOptions {
  inner: AgentGateway;
  /** The harness kind whose factory produced `inner`. */
  kind: string;
  /** The directory this session works in, as the index groups rows by it. */
  cwd: string;
  store: SessionStore;
  logger: MorseLogger;
  /** The index row being resumed, when this gateway was opened by Morse id. */
  record?: MorseSessionRecord;
  /** Notified whenever the row's id changes (seed, resume, fork) or is released on dispose. */
  onIdChange?: (previous: string | undefined, next: string | undefined) => void;
}

/**
 * The wrapped gateway every host's registry sees: its `state()` and its
 * `agent/ready` / `agent/state` events name the session by the Morse-derived
 * id, while everything else passes through to the harness untouched.
 *
 * The id is derived from the engine kind plus the engine's own session id, so a
 * restart or another host derives the same one. One override an adapter needs —
 * a fork, which moves the session to a *new* engine id — re-derives here too
 * and writes the fork's row under the derived id with the previous id as
 * parent, so `SessionRegistry.forkActive`'s re-key keeps working without
 * knowing either engine.
 *
 * The gateway also keeps its row fresh: a new session's first prompt names it,
 * and each exchange moves the count. That keeps the sidebar (which reads the
 * index, not engines) current without an engine read per paint. The write is
 * deliberately tokenless: the engine has said nothing new, so the last token it
 * reported stays valid and a later reconcile still skips unchanged sessions.
 */
export class RoutedGateway implements AgentGateway {
  /** The harness kind whose factory produced this session; its records carry it. */
  readonly kind: string;
  private row: MorseSessionRecord | undefined;
  /** The id last reported to `onIdChange`, so a re-key is announced once. */
  private announcedId: string | undefined;
  /** The record-carried fields a new row starts from, when resuming. */
  private readonly carried: MorseSessionRecord | undefined;
  private readonly options: RoutedOptions;
  /** Given through only when the harness gateway has it, so presence mirrors it. */
  readonly refreshCommands: (() => Promise<void>) | undefined;
  readonly refreshModels: (() => Promise<void>) | undefined;
  readonly setMode: ((mode: string) => Promise<void>) | undefined;
  readonly refreshModes: (() => Promise<void>) | undefined;
  /** Given through only when the harness gateway has it, so presence mirrors it. */
  readonly refreshHistory: (() => Promise<void>) | undefined;

  constructor(options: RoutedOptions) {
    this.options = options;
    this.kind = options.kind;
    this.carried = options.record;
    const inner = options.inner;
    this.refreshCommands =
      inner.refreshCommands === undefined ? undefined : () => inner.refreshCommands!();
    this.refreshModels =
      inner.refreshModels === undefined ? undefined : () => inner.refreshModels!();
    this.setMode = inner.setMode === undefined ? undefined : (mode) => inner.setMode!(mode);
    this.refreshModes = inner.refreshModes === undefined ? undefined : () => inner.refreshModes!();
    this.refreshHistory =
      inner.refreshHistory === undefined ? undefined : () => inner.refreshHistory!();
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.options.inner.subscribe((event) => listener(this.rekey(event)));
  }

  async state(): Promise<AgentSessionState> {
    return this.rekey(await this.options.inner.state());
  }

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const result = await this.options.inner.fork(entryId);
    if (result.cancelled) {
      // The conversation is untouched, so the row and the id both stand.
      return result;
    }
    // The engine moved the session: absorbing the next state re-derives the id
    // and writes the fork's row before any caller looks again.
    await this.state();
    return result;
  }

  async history(options?: { limit?: number; before?: string }) {
    const page = await this.options.inner.history(options);
    return {
      ...page,
      entries: page.entries.map((entry) =>
        entry.role === 'tool' && entry.childSession !== undefined
          ? { ...entry, childSession: this.rekeyChild(entry.childSession) }
          : entry,
      ),
    };
  }

  prompt(
    text: string,
    mode: Parameters<AgentGateway['prompt']>[1],
    images?: Parameters<AgentGateway['prompt']>[2],
    pins?: Parameters<AgentGateway['prompt']>[3],
  ) {
    return this.options.inner.prompt(text, mode, images, pins);
  }

  forkMessages() {
    return this.options.inner.forkMessages();
  }

  abort() {
    return this.options.inner.abort();
  }

  setModel(model: ModelRef) {
    return this.options.inner.setModel(model);
  }

  setThinkingLevel(level: Parameters<AgentGateway['setThinkingLevel']>[0]) {
    return this.options.inner.setThinkingLevel(level);
  }

  compact(customInstructions?: string) {
    return this.options.inner.compact(customInstructions);
  }

  respondToInteraction(response: Parameters<AgentGateway['respondToInteraction']>[0]) {
    return this.options.inner.respondToInteraction(response);
  }

  dispose() {
    return this.options.inner.dispose().finally(() => {
      // The session is no longer running here: from now on a report that omits
      // it is allowed to remove its row (the engine has released the file).
      if (this.announcedId !== undefined) {
        this.options.onIdChange?.(this.announcedId, undefined);
        this.announcedId = undefined;
      }
    });
  }

  /** Routes an event the harness emitted, by keying the states it carries. */
  private rekey(event: AgentEvent): AgentEvent;
  private rekey(state: AgentSessionState): AgentSessionState;
  private rekey(value: AgentEvent | AgentSessionState): AgentEvent | AgentSessionState {
    // A state has no `type`; only events do. That is the whole discrimination.
    if ('type' in value) {
      if (value.type !== 'agent/ready' && value.type !== 'agent/state') {
        return this.rekeyChildInEvent(value);
      }
      this.absorb(value.state);
      this.announce();
      if (this.row === undefined) {
        return value;
      }
      return {
        ...value,
        state: {
          ...value.state,
          sessionId: this.row.id,
          engineSessionId: value.state.engineSessionId ?? value.state.sessionId,
        },
      };
    }
    this.absorb(value);
    this.announce();
    return this.row === undefined
      ? value
      : {
          ...value,
          sessionId: this.row.id,
          engineSessionId: value.engineSessionId ?? value.sessionId,
        };
  }

  /**
   * A child link arrives naming the engine's own session; a frontend opens it
   * by the Morse id, the same key the sidebar and every tab use. The kind is
   * fixed per gateway, so the derivation is exactly the one this session's own
   * id uses. Adapters keep reporting engine ids — only this layer, which owns
   * the id scheme, translates.
   */
  private rekeyChild(child: AgentChildSessionRef): AgentChildSessionRef {
    return {
      ...child,
      sessionId: deriveSessionId({ engine: this.kind, sessionId: child.sessionId }),
    };
  }

  /** Translates a tool event's child link, when the event carries one. */
  private rekeyChildInEvent(event: AgentEvent): AgentEvent {
    if (
      (event.type !== 'agent/tool-start' &&
        event.type !== 'agent/tool-update' &&
        event.type !== 'agent/tool-end') ||
      event.childSession === undefined
    ) {
      return event;
    }
    return { ...event, childSession: this.rekeyChild(event.childSession) };
  }

  /** Tells the router this gateway is now running the row (or the forked one). */
  private announce(): void {
    const id = this.row?.id;
    if (id === undefined || id === this.announcedId) {
      return;
    }
    this.options.onIdChange?.(this.announcedId, id);
    this.announcedId = id;
  }

  /**
   * Folds an engine state into the row: the first report seeds it, a *changed*
   * engine id re-keys it (a fork), and every report refreshes the title and
   * count the sidebar reads.
   */
  private absorb(state: AgentSessionState): void {
    const engineId = state.sessionId;
    if (engineId === undefined) {
      return; // A never-recording probe, most likely.
    }
    const derivedId = deriveSessionId({ engine: this.kind, sessionId: engineId });
    const row = this.row;

    if (row !== undefined && row.engineRef.sessionId === engineId) {
      // Same engine session: only the mutable fields can have moved.
      const title = state.sessionTitle ?? row.title;
      const messageCount = state.counts?.totalMessages ?? row.messageCount;
      if (title !== row.title || messageCount !== row.messageCount) {
        this.row = { ...row, title, messageCount, updatedAt: nowOr(row.createdAt) };
        this.write();
      }
      return;
    }

    if (row !== undefined) {
      // A fork: this gateway now speaks for the child. The parent's row stays
      // so the child nests under it, and the child inherits what it shares.
      this.row = {
        ...row,
        id: derivedId,
        engineRef: { engine: this.kind, sessionId: engineId },
        title: state.sessionTitle ?? row.title,
        createdAt: row.createdAt,
        updatedAt: nowOr(row.createdAt),
        messageCount: state.counts?.totalMessages ?? row.messageCount,
        parentId: row.id,
      };
      this.write();
      return;
    }

    const carried = this.carried;
    if (carried !== undefined && carried.engineRef.sessionId === engineId) {
      // Resumed: the row exists; the report may only have refreshed it.
      const title = state.sessionTitle ?? carried.title;
      const messageCount = state.counts?.totalMessages ?? carried.messageCount;
      this.row =
        title !== carried.title || messageCount !== carried.messageCount
          ? {
              ...carried,
              title,
              messageCount,
              updatedAt: Math.max(carried.updatedAt, nowOr(carried.createdAt)),
            }
          : carried;
      if (this.row !== carried) {
        this.write();
      }
      return;
    }

    // First engine id of a new session: seed the row Morse will show.
    this.row = {
      version: 2,
      id: derivedId,
      title: state.sessionTitle ?? UNTITLED_SESSION,
      cwd: this.options.cwd,
      engineRef: { engine: this.kind, sessionId: engineId },
      createdAt: nowOr(0),
      updatedAt: nowOr(0),
      messageCount: state.counts?.totalMessages ?? 0,
    };
    this.write();
  }

  /** Persists the current row without a token: the engine said nothing new. */
  private write(): void {
    const row = this.row;
    if (row === undefined) {
      return;
    }
    void this.options.store.write(row, undefined).catch((error: unknown) => {
      // A row that cannot be written is a stale sidebar, not a lost conversation.
      this.options.logger.warn(`Could not persist the session record for ${row.id}`, error);
    });
  }
}

/** Epoch milliseconds, kept from ever counting down to a real 1970 row. */
function nowOr(fallback: number): number {
  return Math.max(Date.now(), fallback);
}

function sortedByRecency(records: readonly MorseSessionRecord[]): MorseSessionRecord[] {
  return [...records].sort((left, right) => right.updatedAt - left.updatedAt);
}

function baseName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .at(-1) ?? path
  );
}
