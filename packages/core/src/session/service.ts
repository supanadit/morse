import type {
  AgentEvent,
  AgentForkMessage,
  AgentHistoryEntry,
  AgentInteractionResponse,
  AgentSessionState,
  ChatPin,
  ModelRef,
  ProjectSummary,
  PromptImage,
  SessionSummary,
  ThinkingLevel,
  WorkspaceRef,
} from '../domain.js';
import { AgentUnavailableError, UnsupportedByHostError } from '../errors.js';
import type { MorseLogger } from '../logger.js';

/** Re-exported so the chat use case (and older imports) keep their import path. */
export type { PromptImage };

export type PromptMode = 'new' | 'steer' | 'followUp';

export type PromptDisposition = 'started' | 'queued' | 'handled';

export type AgentEventListener = (event: AgentEvent) => void;

/**
 * Driven port (R2): the coding agent Morse drives, one instance per session.
 * Declared in the module that owns the gateway lifetime, implemented by
 * `@morse/adapter-pi-rpc` (subprocess) — or an SDK adapter later.
 */
export interface AgentGateway {
  subscribe(listener: AgentEventListener): () => void;
  state(): Promise<AgentSessionState>;
  /**
   * Finished exchanges of a resumed session (empty for a new one), newest page
   * first. Page from the end so a large session opens without loading it all.
   */
  history(options?: { limit?: number; before?: string }): Promise<AgentHistoryPage>;
  prompt(
    text: string,
    mode: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
  ): Promise<PromptDisposition>;
  /**
   * Past user messages the agent can fork from, in conversation order. A
   * frontend uses this to turn "edit my old prompt" into a fork of that entry.
   */
  forkMessages(): Promise<AgentForkMessage[]>;
  /**
   * Re-parents the conversation before `entryId`, discarding that message and
   * everything after it, and returns the message text that was dropped. The
   * agent keeps running, but its session id changes: a fork is a new session.
   */
  fork(entryId: string): Promise<{ text: string; cancelled: boolean }>;
  abort(): Promise<void>;
  /**
   * Re-reads the commands the agent exposes — prompt templates especially, which
   * pi caches at spawn. Optional: an adapter that cannot re-read resources simply
   * omits it and the palette keeps what the last `state()` reported.
   */
  refreshCommands?(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  respondToInteraction(response: AgentInteractionResponse): Promise<void>;
  dispose(): Promise<void>;
}

/** Driven port (R2): creates a gateway for a workspace / persisted session. */
export interface AgentGatewayFactory {
  create(options: { workspace: WorkspaceRef; sessionId?: string }): Promise<AgentGateway>;
  /**
   * Optional: a gateway that never records — pi spawned with `--no-session` —
   * used only to read what the backend offers before any session exists (model
   * catalog, thinking levels, commands). Adapters without a session-less mode
   * omit it, and the draft state simply ships without a catalog.
   */
  probeDefaults?(options: { workspace: WorkspaceRef }): Promise<AgentGateway>;
}

/** Driven port (R2): reads persisted sessions. */
export interface SessionCatalog {
  list(): Promise<SessionSummary[]>;
  /**
   * Deletes a persisted session. Optional on purpose: a catalog whose storage
   * Morse must not touch simply omits it, and the use case reports that
   * instead of pretending the session is gone. How a session is stored — and
   * therefore what deleting it means — belongs to the implementation.
   */
  remove?(id: string): Promise<void>;
}

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

/** One page of a resumed session's finished exchanges. */
export interface AgentHistoryPage {
  entries: AgentHistoryEntry[];
  /** True when entries exist before this page. */
  hasOlder: boolean;
  /** Opaque cursor to pass as `before` for the next older page. */
  before?: string;
}

/** Result of forking the active session before a past user message. */
export interface ForkedSession {
  /** Registry key after the fork (the new session id); unchanged when cancelled. */
  key: string;
  /** Registry key the session had before the fork. */
  previousKey: string;
  state: AgentSessionState;
  /** Text of the message the fork re-opened, for restoring the editor. */
  text: string;
  cancelled: boolean;
}

export interface SessionRegistryDeps {
  factory: AgentGatewayFactory;
  catalog: SessionCatalog;
  /** Workspace for sessions started without an explicit project. */
  defaultWorkspace: WorkspaceRef;
  /** How many `pi` processes stay alive at once (least recently used first). */
  hotLimit?: number;
  logger: MorseLogger;
}

const DEFAULT_HOT_LIMIT = 4;

interface HotSession {
  key: string;
  gateway: AgentGateway;
  workspace: WorkspaceRef;
  detach: () => void;
  state: AgentSessionState;
}

/**
 * Session use case: owns every live agent gateway, keeps the most recent ones
 * hot (LRU), and fans their events out tagged with the session key.
 *
 * Multiple projects and multiple sessions therefore run at the same time, which
 * is what a browser host needs — and because `AgentGatewayFactory.create()`
 * already takes a workspace per session, the adapter did not change at all.
 */
export class SessionRegistry {
  private readonly hot = new Map<string, HotSession>();
  /** Least recently used first. */
  private readonly recency: string[] = [];
  private readonly listeners = new Set<(event: TaggedAgentEvent) => void>();
  private readonly hotLimit: number;
  private activeKey: string | undefined;
  private syntheticKeys = 0;
  /** Cached snapshot of a never-recording spawn (see `draftDefaults`). */
  private draftCache: AgentSessionState | undefined;
  private draftProbe: Promise<AgentSessionState | undefined> | undefined;

  constructor(private readonly deps: SessionRegistryDeps) {
    this.hotLimit = Math.max(1, deps.hotLimit ?? DEFAULT_HOT_LIMIT);
  }

  get defaultWorkspace(): WorkspaceRef {
    return this.deps.defaultWorkspace;
  }

  subscribe(listener: (event: TaggedAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  activeKeyOf(): string | undefined {
    return this.activeKey;
  }

  active(): AgentGateway | undefined {
    return this.activeKey === undefined ? undefined : this.hot.get(this.activeKey)?.gateway;
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

  hotKeys(): string[] {
    return [...this.recency];
  }

  /**
   * What the backend offers before any session exists: the model catalog,
   * thinking levels and commands of an untouched spawn. Probed once per
   * registry — never per client — from a gateway that never records itself
   * (pi `--no-session`), so the empty state can ship a real model picker
   * without creating a session.
   */
  async draftDefaults(): Promise<AgentSessionState | undefined> {
    if (this.draftCache) {
      return this.draftCache;
    }
    if (!this.draftProbe) {
      // A rejected probe must not be memoized: the setup screen's Retry (or the
      // next draft) has to be able to reach pi once the user installed it.
      this.draftProbe = this.probeDraft().catch((error: unknown) => {
        this.draftProbe = undefined;
        throw error;
      });
    }
    return this.draftProbe;
  }

  /** Opens a new (or resumes an existing) session and makes it active. */
  async open(options: { workspace?: WorkspaceRef; sessionId?: string } = {}): Promise<OpenedSession> {
    const workspace = options.workspace ?? this.deps.defaultWorkspace;
    const gateway = await this.deps.factory.create({
      workspace,
      sessionId: options.sessionId,
    });
    const state = await gateway.state();
    const key = state.sessionId ?? this.nextSyntheticKey(workspace);

    const alreadyHot = this.hot.get(key);
    if (alreadyHot) {
      // Same session file: keep the running process and drop the duplicate.
      await gateway.dispose().catch((error: unknown) => {
        this.deps.logger.warn('Failed to dispose a duplicate agent gateway', error);
      });
      this.touch(key);
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
    this.touch(key);
    this.activeKey = key;
    await this.evictBeyondLimit();
    return { key, state, reused: false };
  }

  /** Switches to a hot session, or opens it when it is not running anymore. */
  async activate(key: string, workspace?: WorkspaceRef): Promise<OpenedSession> {
    const existing = this.hot.get(key);
    if (existing) {
      this.touch(key);
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
   */
  async forkActive(entryId: string): Promise<ForkedSession> {
    const previousKey = this.activeKey;
    const hot = previousKey === undefined ? undefined : this.hot.get(previousKey);
    if (previousKey === undefined || !hot) {
      throw new AgentUnavailableError('No active Morse session. Open a session first.');
    }
    const result = await hot.gateway.fork(entryId);
    // A cancelled fork leaves the session untouched and still reports its state.
    const state = await hot.gateway.state();
    if (result.cancelled) {
      return { key: previousKey, previousKey, state, text: result.text, cancelled: true };
    }
    const key = state.sessionId ?? this.nextSyntheticKey(hot.workspace);
    if (key === previousKey) {
      return { key, previousKey, state, text: result.text, cancelled: false };
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
    const index = this.recency.indexOf(previousKey);
    if (index >= 0) {
      this.recency[index] = key;
    } else {
      this.recency.push(key);
    }
    this.activeKey = key;
    return { key, previousKey, state, text: result.text, cancelled: false };
  }

  async close(key: string): Promise<void> {
    const session = this.hot.get(key);
    this.forget(key);
    if (!session) {
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

  listSessions(): Promise<SessionSummary[]> {
    return this.deps.catalog.list();
  }

  /** Projects are the directories pi has session buckets for. */
  async listProjects(sessions?: readonly SessionSummary[]): Promise<ProjectSummary[]> {
    const all = sessions ?? (await this.listSessions());
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
        name: baseName(session.cwd),
        sessionCount: 1,
        lastUsedAt: session.updatedAt,
      });
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
    this.recency.length = 0;
    this.listeners.clear();
    this.activeKey = undefined;
    this.draftCache = undefined;
    this.draftProbe = undefined;
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

  private touch(key: string): void {
    const index = this.recency.indexOf(key);
    if (index >= 0) {
      this.recency.splice(index, 1);
    }
    this.recency.push(key);
  }

  private forget(key: string): void {
    const index = this.recency.indexOf(key);
    if (index >= 0) {
      this.recency.splice(index, 1);
    }
    this.hot.delete(key);
    if (this.activeKey === key) {
      this.activeKey = undefined;
    }
  }

  /**
   * Keeps at most `hotLimit` processes alive, retiring the coldest one that is
   * not working. A running session is never killed: when every candidate is
   * mid-run the registry goes over the limit instead, because dropping a
   * parallel conversation is worse than a few extra processes.
   */
  private async evictBeyondLimit(): Promise<void> {
    while (this.recency.length > this.hotLimit) {
      const coldest = this.recency.find((key) => key !== this.activeKey && !this.isWorking(key));
      if (coldest === undefined) {
        return;
      }
      this.deps.logger.info(`Retiring idle session ${coldest} (hot limit ${this.hotLimit})`);
      await this.close(coldest);
    }
  }

  /** A session the agent is answering in is off limits for the LRU. */
  private isWorking(key: string): boolean {
    return this.hot.get(key)?.state.streaming === true;
  }

  private nextSyntheticKey(workspace: WorkspaceRef): string {
    this.syntheticKeys += 1;
    return `${workspace.cwd}#ephemeral-${this.syntheticKeys}`;
  }

  /** Asks the factory for a never-recording gateway and snapshots its state. */
  private async probeDraft(): Promise<AgentSessionState | undefined> {
    const factory = this.deps.factory.probeDefaults;
    if (!factory) {
      return undefined;
    }
    try {
      const gateway = await factory.call(this.deps.factory, { workspace: this.deps.defaultWorkspace });
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

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}
