import type {
  AgentEvent,
  AgentGateway,
  AgentSessionState,
  ModelRef,
  SessionEngine,
} from '@morse/agent';
import type { ProjectSummary, SessionSummary } from '../domain/index.js';
import type { WorkspaceRef } from '@morse/agent';
import { AgentUnavailableError, UnsupportedByHostError } from '../errors.js';
import type { MorseLogger } from '../logger.js';
import type { SessionCatalog, SessionFactory, SessionPage, SessionStore } from './ports.js';
import { reconcileSessions, type ReconcileResult } from './reconcile.js';

/**
 * Session use case: owns every live agent gateway, fans their events out
 * tagged with the session key, and reads the session catalog for the sidebar.
 *
 * Every opened session stays live until it is explicitly closed, removed, or
 * the host shuts down — there is no hot limit and no eviction. A session the
 * reader opened is a running process, so switching back to it is always
 * instant; the cost is one process per open session for the host's lifetime.
 *
 * The ports it consumes are in `ports.ts`; the record it writes is in `record.ts`
 * and `reconcile.ts`. Only the use case lives here.
 */

/** An event from any hot session, tagged with the session it came from. */
export interface TaggedAgentEvent {
  sessionKey: string;
  event: AgentEvent;
}

export interface OpenedSession {
  key: string;
  state: AgentSessionState;
  /** True when an already-running session was reused (no new `pi` process). */
  reused: boolean;
}

/** Result of a branch operation (fork, rewrite or clone) on the active session. */
export interface ForkedSession {
  /** Registry key after the branch: a new session id, or the same key for an in-place rewrite. Unchanged when cancelled. */
  key: string;
  /** Registry key the session had before the branch. */
  previousKey: string;
  state: AgentSessionState;
  /** Text of the message the branch re-opened, for restoring the editor. */
  text: string;
  cancelled: boolean;
}

/** What a manual agent-config reload did, for the control that asked. */
export interface ReloadedAgentConfig {
  /** True when the engine reloaded its config and the warm sessions were refreshed. */
  reloaded: boolean;
  /** True when a turn was running and `force` was not given: nothing reloaded yet. */
  requiresConfirmation?: boolean;
  /** How many sessions of that engine were mid-turn when the reload was asked for. */
  running: number;
}

export interface SessionRegistryDeps {
  factory: SessionFactory;
  catalog: SessionCatalog;
  /** Workspace for sessions started without an explicit project. */
  defaultWorkspace: WorkspaceRef;
  logger: MorseLogger;
  /**
   * The engines behind this registry, when the host has several. Used only by
   * `reconcile()`, which needs each engine's optional `scan()`; a registry built
   * without them simply cannot reconcile.
   */
  engines?: readonly SessionEngine[];
}

interface HotSession {
  key: string;
  gateway: AgentGateway;
  workspace: WorkspaceRef;
  detach: () => void;
  state: AgentSessionState;
}

/**
 * Session use case: owns every live agent gateway and fans their events out
 * tagged with the session key.
 *
 * Multiple projects and multiple sessions therefore run at the same time, which
 * is what a browser host needs — and because `AgentGatewayFactory.create()`
 * already takes a workspace per session, the adapter did not change at all.
 */
export class SessionRegistry {
  private readonly hot = new Map<string, HotSession>();
  private readonly listeners = new Set<(event: TaggedAgentEvent) => void>();
  /**
   * Notified whenever a session stops being live — an explicit close or a
   * delete. This is the registry's own teardown signal: the process is gone,
   * so anything a host kept keyed by that session key (a warm transcript, a
   * paging cursor) must be dropped with it.
   */
  private readonly removals = new Set<(key: string) => void>();
  private activeKey: string | undefined;
  private syntheticKeys = 0;
  /** Cached snapshots of never-recording probes, keyed by engine, model, mode, project and signature. */
  private readonly draftCache = new Map<string, AgentSessionState>();
  private readonly draftProbes = new Map<string, Promise<AgentSessionState | undefined>>();
  /**
   * The config fingerprint last read per `engine|project`. A changed fingerprint
   * means the config files the draft reads were edited, so every cached catalog
   * (and any probe still in flight) was built from a config the engine no
   * longer uses.
   */
  private readonly draftSignatures = new Map<string, string>();

  constructor(private readonly deps: SessionRegistryDeps) {}

  get defaultWorkspace(): WorkspaceRef {
    return this.deps.defaultWorkspace;
  }

  subscribe(listener: (event: TaggedAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Observes sessions closing, for any reason. A host uses it to release
   * per-session state (the warm transcript) at exactly the moment its process
   * is retired, instead of holding it until the host shuts down.
   */
  onRemoval(listener: (key: string) => void): () => void {
    this.removals.add(listener);
    return () => {
      this.removals.delete(listener);
    };
  }

  activeKeyOf(): string | undefined {
    return this.activeKey;
  }

  active(): AgentGateway | undefined {
    return this.activeKey === undefined ? undefined : this.hot.get(this.activeKey)?.gateway;
  }

  /**
   * The gateway of one hot session, so a prompt can be addressed to a session
   * other than the active one — a queued follow-up draining while the reader
   * looks at another tab. Undefined once the session is no longer hot.
   */
  agentFor(key: string): AgentGateway | undefined {
    return this.hot.get(key)?.gateway;
  }

  requireActive(): AgentGateway {
    const gateway = this.active();
    if (!gateway) {
      throw new AgentUnavailableError('No active Morse session. Open a session first.');
    }
    return gateway;
  }

  stateOf(key: string): AgentSessionState | undefined {
    return this.hot.get(key)?.state;
  }

  /** The kind of the engine that owns a hot session; undefined once it is cold. */
  engineOf(key: string): string | undefined {
    return this.hot.get(key)?.gateway.kind;
  }

  hotKeys(): string[] {
    return [...this.hot.keys()];
  }

  /**
   * Forgets the session-less probe caches, so the next `draftDefaults()` runs pi
   * again. The model picker calls it while the panel is still on a draft, where
   * spawning nothing would otherwise freeze the catalog for the host's lifetime.
   */
  refreshDraftDefaults(): void {
    this.draftCache.clear();
    this.draftProbes.clear();
    this.draftSignatures.clear();
  }

  /**
   * Re-reads the model catalog of every live session. A provider change (new
   * credential, endpoint or model) is host-wide, so every active client's
   * picker must see it on the next frame rather than after a restart or reload.
   */
  async refreshAllModels(): Promise<void> {
    const refreshes: Promise<void>[] = [];
    for (const session of this.hot.values()) {
      const refresh = session.gateway.refreshModels;
      if (refresh === undefined) {
        continue;
      }
      refreshes.push(
        refresh.call(session.gateway).catch((error: unknown) => {
          this.deps.logger.warn(
            `Could not refresh models for session ${session.key} after a provider change`,
            error,
          );
        }),
      );
    }
    await Promise.all(refreshes);
  }

  /**
   * The catalog already probed for a draft's engine, model, mode and project,
   * when there is one. Synchronous on purpose: a reader switching back to a model
   * Morse has already read the levels of gets them in the same frame as the pick
   * instead of watching a loading row for a probe that is not needed. The config
   * signature is checked first, so an edited config misses here exactly as it
   * misses in `draftDefaults()`.
   */
  cachedDraftDefaults(
    engine?: string,
    model?: ModelRef,
    mode?: string,
    workspace?: WorkspaceRef,
  ): AgentSessionState | undefined {
    const project = workspace ?? this.deps.defaultWorkspace;
    const signature = this.syncDraftSignature(engine, project);
    return this.draftCache.get(draftKey({ engine, model, mode, workspace: project, signature }));
  }

  /**
   * What the backend offers before any session exists: the model catalog,
   * thinking levels, modes and commands of an untouched probe. Probed once per
   * `(engine, model, mode, project)` — never per client — from a gateway that
   * never records itself (pi `--no-session`, OpenCode's catalog reads), so the
   * empty state can ship real pickers without creating a session. Passing
   * `engine` probes the engine the draft selected; passing `model` asks for that
   * model's thinking levels, which pi reports per current model; passing `mode`
   * and `workspace` asks for the catalogs of the mode and project the draft has
   * chosen, because the effective agent and the config files both come from them.
   */
  async draftDefaults(
    engine?: string,
    model?: ModelRef,
    mode?: string,
    workspace?: WorkspaceRef,
  ): Promise<AgentSessionState | undefined> {
    const project = workspace ?? this.deps.defaultWorkspace;
    const signature = this.syncDraftSignature(engine, project);
    const key = draftKey({ engine, model, mode, workspace: project, signature });
    const cached = this.draftCache.get(key);
    if (cached) {
      return cached;
    }
    let probe = this.draftProbes.get(key);
    if (!probe) {
      // A rejected probe must not be memoized: the setup screen's Retry (or the
      // next draft) has to be able to reach the engine once the user installed it.
      probe = this.probeDraft({ engine, model, mode, workspace: project })
        .then((state) => {
          if (state) {
            this.draftCache.set(key, state);
          }
          return state;
        })
        .catch((error: unknown) => {
          this.draftProbes.delete(key);
          throw error;
        });
      this.draftProbes.set(key, probe);
    }
    return probe;
  }

  /**
   * Re-reads an engine's own configuration — its models, agents/modes, commands
   * and skills — then drops the draft catalogs read before the reload and tells
   * every warm session of that engine to re-read too.
   *
   * A running turn is the one thing this refuses: the engine rebuilds its
   * catalogs while working, and a reader must confirm before a reload lands
   * under it. The count is scoped to the named engine (the factory's default
   * when the draft named none), so another engine's turn never blocks it.
   *
   * The factory answers `false` when the named engine has no config to reload
   * (a router that always exposes the method); the caches then keep what they
   * read, because nothing on the engine changed to invalidate them.
   */
  async reloadAgentConfig(
    options: { engine?: string; cwd?: string; force?: boolean } = {},
  ): Promise<ReloadedAgentConfig> {
    const engine = options.engine ?? this.deps.factory.defaultEngineKind;
    const running = this.runningSessions(engine);
    if (running > 0 && options.force !== true) {
      return { reloaded: false, requiresConfirmation: true, running };
    }
    const reload = this.deps.factory.reloadConfig;
    if (reload === undefined) {
      return { reloaded: false, running };
    }
    const performed = await reload.call(this.deps.factory, {
      ...(engine === undefined ? {} : { engine }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    if (performed === false) {
      return { reloaded: false, running };
    }
    // Every cached draft was read from the config the engine just replaced.
    this.refreshDraftDefaults();
    await this.refreshWarmGateways(engine);
    return { reloaded: true, running };
  }

  /** The engine kinds this registry can open, for validating a draft choice. */
  engineKinds(): string[] {
    return (this.deps.engines ?? []).map((engine) => engine.kind);
  }

  /** Opens a new (or resumes an existing) session and makes it active. */
  async open(
    options: { workspace?: WorkspaceRef; sessionId?: string; engine?: string; mode?: string } = {},
  ): Promise<OpenedSession> {
    const workspace = options.workspace ?? this.deps.defaultWorkspace;
    const gateway = await this.deps.factory.create({
      workspace,
      sessionId: options.sessionId,
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    const state = await gateway.state();
    const key = state.sessionId ?? this.nextSyntheticKey(workspace);

    const alreadyHot = this.hot.get(key);
    if (alreadyHot) {
      // Same session file: keep the running process and drop the duplicate.
      await gateway.dispose().catch((error: unknown) => {
        this.deps.logger.warn('Failed to dispose a duplicate agent gateway', error);
      });
      this.activeKey = key;
      return { key, state: alreadyHot.state, reused: true };
    }

    this.hot.set(key, {
      key,
      gateway,
      workspace,
      detach: gateway.subscribe((event) => {
        this.emit({ sessionKey: key, event: this.absorb(key, event) });
      }),
      state,
    });
    this.activeKey = key;
    return { key, state, reused: false };
  }

  /** Switches to a hot session, or opens it when it is not running anymore. */
  async activate(key: string, workspace?: WorkspaceRef): Promise<OpenedSession> {
    const existing = this.hot.get(key);
    if (existing) {
      this.activeKey = key;
      return { key, state: existing.state, reused: true };
    }
    return this.open({ workspace, sessionId: key });
  }

  /**
   * Forks the active session before a past user message. pi's fork writes a
   * *new* session file while reusing the same subprocess, so the hot entry is
   * re-keyed to the new session id instead of respawning the agent. The
   * controller truncates its transcript to match, then sends the edited prompt.
   *
   * `sessionKey` names the session to fork when the caller is not the host's
   * shared "session in front" — a VS Code editor tab pinned to one conversation
   * forks its own branch, not whichever session some other panel last activated.
   */
  forkActive(entryId: string, sessionKey?: string): Promise<ForkedSession> {
    return this.branchActive('fork', entryId, sessionKey);
  }

  /**
   * Rewrites the active session from a past user message. An engine that can
   * edit in place keeps its session id and the hot entry stands; one that
   * branches (pi has no edit primitive) re-keys exactly like a fork.
   */
  rewriteActive(entryId: string, sessionKey?: string): Promise<ForkedSession> {
    return this.branchActive('rewrite', entryId, sessionKey);
  }

  /** Branches the active session at its tip into a copy the reader continues in. */
  cloneActive(sessionKey?: string): Promise<ForkedSession> {
    return this.branchActive('clone', undefined, sessionKey);
  }

  /**
   * The one body the three branch operations share: the engine moves the
   * conversation (to a new session id, or in place for a rewrite), and the hot
   * entry follows it rather than being respawned. A cancelled branch leaves the
   * session untouched and still reports its state.
   */
  private async branchActive(
    operation: 'fork' | 'rewrite' | 'clone',
    entryId: string | undefined,
    sessionKey?: string,
  ): Promise<ForkedSession> {
    const previousKey = sessionKey ?? this.activeKey;
    const hot = previousKey === undefined ? undefined : this.hot.get(previousKey);
    if (previousKey === undefined || !hot) {
      throw new AgentUnavailableError('No active Morse session. Open a session first.');
    }
    const result =
      operation === 'fork'
        ? await hot.gateway.fork(entryId ?? '')
        : operation === 'rewrite'
          ? await hot.gateway.rewrite(entryId ?? '')
          : await hot.gateway.clone();
    // Only a fork and a rewrite report the message they dropped; a clone has
    // none. (`typeof` because `in` narrows the omitted side to unknown.)
    const text = 'text' in result && typeof result.text === 'string' ? result.text : '';
    const state = await hot.gateway.state();
    if (result.cancelled) {
      return { key: previousKey, previousKey, state, text, cancelled: true };
    }
    const key = state.sessionId ?? this.nextSyntheticKey(hot.workspace);
    if (key === previousKey) {
      return { key, previousKey, state, text, cancelled: false };
    }

    hot.detach();
    this.hot.delete(previousKey);
    this.hot.set(key, {
      key,
      gateway: hot.gateway,
      workspace: hot.workspace,
      state,
      detach: hot.gateway.subscribe((event) => {
        this.emit({ sessionKey: key, event: this.absorb(key, event) });
      }),
    });
    // Only adopt the branch as the host-wide session in front when this call was
    // for it: a pinned tab branching its own conversation must not steal the
    // sidebar's pointer.
    if (sessionKey === undefined || sessionKey === this.activeKey) {
      this.activeKey = key;
    }
    return { key, previousKey, state, text, cancelled: false };
  }

  async close(key: string): Promise<void> {
    const session = this.hot.get(key);
    const wasHot = this.forget(key);
    // Announce even a session that was already cold: the caller asked for it to
    // be gone, so any host state still keyed by it is stale either way. Fired
    // before the gateway await, so a caller's cleanup is not held up by a slow
    // process teardown.
    this.announceRemoval(key);
    if (!session || !wasHot) {
      return;
    }
    session.detach();
    await session.gateway.dispose().catch((error: unknown) => {
      this.deps.logger.warn('Failed to dispose an agent gateway', error);
    });
  }

  /**
   * Deletes a session for good: its hot process first (it may hold the file
   * open), then the stored conversation through the catalog. Storage rules stay
   * in the adapter; this use case owns only the order and the refusal when the
   * host cannot delete at all.
   */
  async remove(key: string): Promise<void> {
    await this.close(key);
    const remove = this.deps.catalog.remove;
    if (!remove) {
      throw new UnsupportedByHostError('This host cannot delete sessions.');
    }
    await remove.call(this.deps.catalog, key);
  }

  /**
   * Merges what every installed engine says it already holds into Morse's
   * session index, once per engine and scoped to its own kind.
   *
   * The use case owns the *order* and the refusal; each engine owns its report,
   * and the store owns the writes. An empty result means no engine can report —
   * deliberately distinct from reports that found nothing.
   */
  async reconcile(options: {
    store: SessionStore;
    /** Used only when the store cannot report its own tokens. */
    tokens?: ReadonlyMap<string, string>;
    onProgress?: (done: number, total: number) => void;
    /**
     * Whether engine sessions the index has never seen are adopted as new
     * rows. Forwarded to every engine's reconcile (see
     * `reconcileSessions.adoptUnknown`); per-user callers pass false.
     */
    adoptUnknown?: boolean;
  }): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    for (const engine of this.deps.engines ?? []) {
      const scan = engine.scan;
      if (scan === undefined) {
        continue;
      }
      results.push(
        await reconcileSessions({
          kind: engine.kind,
          // Bound, so `scan` keeps `this` when a harness overrides it as a method.
          scan: () => scan.call(engine),
          store: options.store,
          ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
          ...(options.adoptUnknown === false ? { adoptUnknown: false as const } : {}),
        }),
      );
    }
    return results;
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.deps.catalog.list();
  }

  /**
   * One indexed session by Morse id. A host folding a hot session into its
   * sidebar uses this to keep the row's true lineage and timestamp instead of
   * fabricating one from the live gateway.
   */
  summary(key: string): Promise<SessionSummary | undefined> {
    return this.deps.catalog.read?.(key) ?? Promise.resolve(undefined);
  }

  /**
   * Sets a title the reader chose. Morse's index holds it, so no engine is
   * started or written to; the catalog answers false when the row is gone.
   */
  async renameSession(key: string, title: string): Promise<boolean> {
    const rename = this.deps.catalog.rename;
    if (!rename) {
      throw new UnsupportedByHostError('This host cannot rename sessions.');
    }
    return rename.call(this.deps.catalog, key, title);
  }

  /**
   * Deletes every session a project directory holds: each one is closed (its
   * process retired, so a file is not removed while open) and then removed
   * through whichever engine owns it. Failures are collected rather than thrown
   * — a cascade that stopped at the first refusal would leave the reader with a
   * half-deleted project and no count of what is left.
   */
  async deleteProject(path: string): Promise<{ deleted: string[]; failed: string[] }> {
    const idsInProject = this.deps.catalog.idsInProject;
    if (!idsInProject) {
      throw new UnsupportedByHostError('This host cannot delete a project’s sessions.');
    }
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const id of await idsInProject.call(this.deps.catalog, path)) {
      try {
        await this.remove(id);
        deleted.push(id);
      } catch {
        failed.push(id);
      }
    }
    return { deleted, failed };
  }

  /**
   * More of one project's sessions, for the sidebar's "Load more" row. A catalog
   * without paging answers with whatever it already has and no more to fetch, so
   * the sidebar simply stops offering to load.
   */
  async listSessionPage(options: {
    cwd: string;
    offset?: number;
    limit?: number;
  }): Promise<SessionPage> {
    const listPage = this.deps.catalog.listPage;
    if (!listPage) {
      return { sessions: [], hasMore: false };
    }
    return listPage.call(this.deps.catalog, options);
  }

  /**
   * True number of stored sessions per project, when the catalog can report it
   * cheaply from its directory listing. The list is paged, so the sidebar uses
   * this to know a project still has sessions past its first page.
   */
  async sessionCounts(): Promise<Map<string, number>> {
    const countByProject = this.deps.catalog.countByProject;
    if (!countByProject) {
      return new Map();
    }
    return countByProject.call(this.deps.catalog).catch(() => new Map());
  }

  /**
   * Sessions matching a query across the whole catalog, for the command palette.
   * A catalog that cannot search returns nothing, and the palette falls back to
   * the pages the sidebar already holds.
   */
  async searchSessions(query: string, limit?: number): Promise<SessionSummary[]> {
    const search = this.deps.catalog.search;
    if (!search) {
      return [];
    }
    return search.call(this.deps.catalog, query, limit);
  }

  /** Projects are the directories the index holds sessions for. */
  async listProjects(sessions?: readonly SessionSummary[]): Promise<ProjectSummary[]> {
    const all = sessions ?? (await this.listSessions());
    // The list is paged per project, so counting only the sessions in it would
    // report a page (10) where the project holds 150. The catalog's directory
    // listing knows the real totals; fall back to the sessions when it cannot say.
    const counts = await this.deps.catalog.countByProject?.().catch(() => undefined);
    const projects = new Map<string, ProjectSummary>();
    for (const session of all) {
      if (session.cwd.length === 0) {
        continue;
      }
      const existing = projects.get(session.cwd);
      if (existing) {
        existing.sessionCount += 1;
        existing.lastUsedAt = Math.max(existing.lastUsedAt, session.updatedAt);
        continue;
      }
      projects.set(session.cwd, {
        path: session.cwd,
        // The default shelf keeps its display name even once it holds
        // sessions — otherwise baseName would leak the login username.
        name: session.cwd === this.deps.defaultWorkspace.cwd
          ? this.deps.defaultWorkspace.name
          : baseName(session.cwd),
        sessionCount: 1,
        lastUsedAt: session.updatedAt,
      });
    }
    if (counts !== undefined) {
      for (const [cwd, count] of counts) {
        const project = projects.get(cwd);
        if (project !== undefined) {
          project.sessionCount = count;
        }
      }
    }
    const defaultPath = this.deps.defaultWorkspace.cwd;
    if (!projects.has(defaultPath)) {
      projects.set(defaultPath, {
        path: defaultPath,
        name: this.deps.defaultWorkspace.name,
        sessionCount: 0,
        lastUsedAt: 0,
      });
    }
    return [...projects.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  }

  async dispose(): Promise<void> {
    const sessions = [...this.hot.values()];
    this.hot.clear();
    this.listeners.clear();
    this.removals.clear();
    this.activeKey = undefined;
    this.draftCache.clear();
    this.draftProbes.clear();
    this.draftSignatures.clear();
    await Promise.all(
      sessions.map((session) => {
        session.detach();
        return session.gateway.dispose().catch((error: unknown) => {
          this.deps.logger.warn('Failed to dispose an agent gateway', error);
        });
      }),
    );
  }

  private absorb(key: string, event: AgentEvent): AgentEvent {
    const session = this.hot.get(key);
    if (session && (event.type === 'agent/ready' || event.type === 'agent/state')) {
      session.state = event.state;
    }
    return event;
  }

  private emit(event: TaggedAgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.deps.logger.error('Agent event listener failed', error);
      }
    }
  }

  /** Returns whether the key was actually hot (so callers do not double-report). */
  private forget(key: string): boolean {
    const existed = this.hot.delete(key);
    if (this.activeKey === key) {
      this.activeKey = undefined;
    }
    return existed;
  }

  /** Fans a session's departure out, isolated so one bad listener cannot stop the rest. */
  private announceRemoval(key: string): void {
    for (const listener of [...this.removals]) {
      try {
        listener(key);
      } catch (error: unknown) {
        this.deps.logger.error('Session removal listener failed', error);
      }
    }
  }

  /** How many hot sessions of one engine are mid-turn; another engine's never count. */
  private runningSessions(engine: string | undefined): number {
    let running = 0;
    for (const session of this.hot.values()) {
      if (session.gateway.kind === engine && session.state.streaming === true) {
        running += 1;
      }
    }
    return running;
  }

  /**
   * Tells the warm sessions of one engine to re-read what the reload replaced.
   * A gateway that cannot re-read (or fails to) keeps its last catalogs; a
   * warning is all the control needs, never a rejected reload.
   */
  private async refreshWarmGateways(engine: string | undefined): Promise<void> {
    const refreshes: Promise<void>[] = [];
    for (const session of this.hot.values()) {
      if (session.gateway.kind !== engine) {
        continue;
      }
      const refresh = session.gateway.refreshConfig;
      if (refresh === undefined) {
        continue;
      }
      refreshes.push(
        refresh.call(session.gateway).catch((error: unknown) => {
          this.deps.logger.warn(
            `Could not refresh session ${session.key} after the ${engine ?? 'default'} config reload`,
            error,
          );
        }),
      );
    }
    await Promise.all(refreshes);
  }

  /**
   * The fingerprint of the config files a draft's project reads, and the
   * invalidation it triggers. Recorded per engine and project: a published
   * fingerprint is content, so a changed one means every cached catalog was
   * read from a config the engine no longer uses.
   */
  private syncDraftSignature(engine: string | undefined, workspace: WorkspaceRef): string {
    const scope = `${engine ?? ''}|${workspace.cwd}`;
    const signature = this.deps.factory.configSignature?.({ workspace, engine }) ?? '';
    const previous = this.draftSignatures.get(scope);
    if (previous !== undefined && previous !== signature) {
      this.draftCache.clear();
      this.draftProbes.clear();
    }
    this.draftSignatures.set(scope, signature);
    return signature;
  }

  private nextSyntheticKey(workspace: WorkspaceRef): string {
    this.syntheticKeys += 1;
    return `${workspace.cwd}#ephemeral-${this.syntheticKeys}`;
  }

  /** Asks the factory for a never-recording gateway and snapshots its state. */
  private async probeDraft(options: {
    engine?: string;
    model?: ModelRef;
    mode?: string;
    workspace: WorkspaceRef;
  }): Promise<AgentSessionState | undefined> {
    const factory = this.deps.factory.probeDefaults;
    if (!factory) {
      return undefined;
    }
    try {
      const gateway = await factory.call(this.deps.factory, {
        workspace: options.workspace,
        ...(options.engine === undefined ? {} : { engine: options.engine }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
      const state = await gateway.state();
      await gateway.dispose();
      return state;
    } catch (error: unknown) {
      // A missing (or un-spawnable) pi is not "no catalog": the empty panel has
      // to say so on load, not only once the first prompt fails. Every other
      // probe failure — a timeout, a protocol slip — keeps the pickers empty and
      // lets the real (recorded) spawn surface it with its actionable hint.
      if (error instanceof AgentUnavailableError) {
        throw error;
      }
      this.deps.logger.warn('Could not probe the draft model catalog', error);
      return undefined;
    }
  }
}

/** One draft probe's identity: which engine, model, mode, project and config it reads. */
interface DraftKey {
  engine?: string;
  model?: ModelRef;
  mode?: string;
  workspace: WorkspaceRef;
  /** The project's config fingerprint when the probe was cached. */
  signature: string;
}

/** Cache identity for a draft probe: the engine, model, mode, project and config signature. */
function draftKey(input: DraftKey): string {
  const model = input.model === undefined ? '' : `${input.model.provider}/${input.model.id}`;
  return [input.engine ?? '', model, input.mode ?? '', input.workspace.cwd, input.signature].join(
    '|',
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}
