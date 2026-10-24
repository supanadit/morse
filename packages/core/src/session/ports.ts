import type { AgentEngineRef, MorseSessionRecord } from './record.js';
import type {
  AgentEvent,
  AgentForkMessage,
  AgentHistoryEntry,
  AgentInteractionResponse,
  AgentSessionState,
  ChatPin,
  ModelRef,
  PromptImage,
  SessionSummary,
  ThinkingLevel,
  WorkspaceRef,
} from '../domain.js';

/**
 * Driven ports (R2) of the session use case.
 *
 * Interfaces and the constants a caller needs to ask for a page. The use case
 * that consumes them lives in `service.ts`; an adapter imports from here, and the
 * rule is the same as everywhere else in this package — a port is declared by the
 * module that consumes it, never by the one that implements it.
 */

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
  /**
   * Optional: re-reads the model catalog for this session. The model picker
   * calls it when it opens, so a model added to `models.json` while the host
   * runs shows up without restarting the host or the session. Adapters that
   * cannot re-read the catalog simply omit it.
   */
  refreshModels?(): Promise<void>;
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
   * omit it, and the draft state simply ships without a catalog. `model` asks
   * the probe for the levels of a specific model, so the draft picker can follow
   * a model the user selected before the session exists.
   */
  probeDefaults?(options: { workspace: WorkspaceRef; model?: ModelRef }): Promise<AgentGateway>;
}

/**
 * How many sessions of one project a catalog returns in a first list. The
 * sidebar shows this page and offers "Load more" for the rest, so a catalog with
 * hundreds of sessions in one project does not make the first paint read all of
 * them. Chosen to keep the cold scan cheap (a real catalog measured ~0.4 s for
 * every project's top 20) while still filling a screen without a click.
 */
export const DEFAULT_SESSIONS_PER_PROJECT = 10;
/**
 * How many sessions the palette's server-side search returns at most. Enough to
 * fill the palette's Sessions section generously; the reader narrows the query
 * rather than scrolling a thousand matches.
 */
export const DEFAULT_SESSION_SEARCH_LIMIT = 50;

/** One project's sessions, newest first, plus whether the catalog holds more. */
export interface SessionPage {
  sessions: SessionSummary[];
  /** True when sessions past this page exist for the same `cwd`. */
  hasMore: boolean;
}

/** Driven port (R2): reads persisted sessions. */
export interface SessionCatalog {
  /**
   * Every project's sessions, newest first, each project capped to a first page
   * so a huge catalog does not have to be read whole. The cap is the catalog's
   * own; `listPage` fetches the rest of one project on demand.
   */
  list(): Promise<SessionSummary[]>;
  /**
   * More of one project's sessions, newest first, starting at `offset`.
   * Optional: a catalog that can only answer `list()` in full omits it, and the
   * sidebar simply has nothing more to load for that project.
   */
  listPage?(options: { cwd: string; offset?: number; limit?: number }): Promise<SessionPage>;
  /**
   * Sessions whose title or project path contains `query`, newest first, capped
   * to `limit`. The palette asks the host this while the reader types, so the
   * frontend never has to hold the whole catalog to search it. Optional: a
   * catalog that cannot search omits it and the palette falls back to the pages
   * it already holds.
   */
  search?(query: string, limit?: number): Promise<SessionSummary[]>;  /**
   * True number of stored sessions per project path. Optional: `list()` caps each
   * project to a page, so a caller that needs the real total (the sidebar's
   * "Load more" and the project counts) asks here. A catalog that cannot answer
   * cheaply omits it and callers fall back to counting the sessions they hold.
   */
  countByProject?(): Promise<Map<string, number>>;
  /**
   * Deletes a persisted session. Optional on purpose: a catalog whose storage
   * Morse must not touch simply omits it, and the use case reports that
   * instead of pretending the session is gone. How a session is stored — and
   * therefore what deleting it means — belongs to the implementation.
   */
  remove?(id: string): Promise<void>;
}

/** One page of a resumed session's finished exchanges. */
export interface AgentHistoryPage {
  entries: AgentHistoryEntry[];
  /** True when entries exist before this page. */
  hasOlder: boolean;
  /** Opaque cursor to pass as `before` for the next older page. */
  before?: string;
}

/**
 * Driven ports (R2) of the session store: where Morse keeps the records it owns,
 * and which engines can enumerate what they already hold.
 */

/**
 * Where Morse keeps the session records.
 *
 * The port is deliberately a plain key/value list and not "the sidebar view": a
 * caller that wants the sidebar's shape projects it with `toSessionSummary` in
 * `record.ts`, and a store never learns about the wire.
 */
export interface SessionStore {
  /** Every known session, in no particular order. Callers sort what they need. */
  list(): Promise<MorseSessionRecord[]>;
  /** One session by Morse id. Undefined when it is gone (deleted outside Morse). */
  read(id: string): Promise<MorseSessionRecord | undefined>;
  /** Writes (or replaces) one session. Idempotent: the same record twice is one write. */
  write(record: MorseSessionRecord): Promise<void>;
  /**
   * Removes one session from the index. Optional on purpose: a store whose
   * backing files live somewhere Morse must not write omits it, and the delete
   * use case then reports that instead of pretending the session is gone.
   */
  remove?(id: string): Promise<void>;
}

/** One session an engine reports as present on its own storage. */
export interface SessionScanEntry {
  /**
   * An engine-opaque token for "this file has not changed". Typically
   * `<mtimeMs>:<size>`: comparing it lets a reconcile skip a 600 MB transcript
   * that only a `stat` was needed to rule out. The index stores the last token it
   * saw, so an unchanged session costs one `stat` and no read.
   */
  token: string;
  /** What the engine knows about the session. `id` is derived, never the engine's. */
  record: MorseSessionRecord;
}

/**
 * An engine whose storage Morse can enumerate.
 *
 * A host reconciles against it at startup (and throttled while running), which is
 * what keeps a session the reader started with the `pi` CLI in a terminal visible
 * in Morse's sidebar. Without a source, the index only knows what Morse itself
 * created — and it would silently hide half the reader's sessions.
 *
 * Optional by design: an engine that keeps sessions behind a remote API and cannot
 * list them cheaply simply is not a source, and the sidebar shows only what the
 * index already holds.
 */
export interface SessionSource {
  /** The `AgentEngineRef.engine` this source enumerates. */
  readonly engine: AgentEngineRef['engine'];
  scan(): Promise<SessionScanEntry[]>;
}
