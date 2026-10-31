import type { AgentGateway, AgentGatewayFactory, WorkspaceRef } from '@morse/agent';
import type { MorseSessionRecord } from './record.js';
import type { SessionSummary } from '../domain/index.js';

/**
 * Driven ports (R2) of the session use case.
 *
 * The harness ports moved to `@morse/agent`; what stays here is Morse's own — the
 * session catalog the sidebar reads, and the store and source behind Morse's index.
 */

/**
 * The session factory the registry drives. It is the harness factory plus the
 * application's own routing choice: an engine kind names which registered
 * harness should create the session. Only `AgentRouter` implements the routing
 * part; a bare harness factory ignores the extra fields and keeps its default.
 */
export interface SessionFactory extends AgentGatewayFactory {
  create(options: {
    workspace: WorkspaceRef;
    sessionId?: string;
    engine?: string;
    mode?: string;
  }): Promise<AgentGateway>;
}

/**
 * How many sessions of one project a catalog returns in a first list. The
 * sidebar shows this page and offers "Load more" for the rest, so a catalog with
 * hundreds of sessions in one project does not make the first paint read all of
 * them.
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
   * to `limit`. Optional: a catalog that cannot search omits it and the palette
   * falls back to the pages it already holds.
   */
  search?(query: string, limit?: number): Promise<SessionSummary[]>;
  /**
   * True number of stored sessions per project path. Optional: `list()` caps each
   * project to a page, so a caller that needs the real total asks here.
   */
  countByProject?(): Promise<Map<string, number>>;
  /**
   * Deletes a persisted session. Optional on purpose: a catalog whose storage
   * Morse must not touch simply omits it, and the use case reports that instead
   * of pretending the session is gone.
   */
  remove?(id: string): Promise<void>;
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
  /**
   * Writes (or replaces) one session. Idempotent: the same record twice is one
   * write.
   *
   * `token` is the engine-reported marker (`AgentSessionInfo.token`) the record
   * was built from, kept *beside* the record rather than inside it: the record
   * stays free of engine storage detail, and a reconcile compares against the
   * last report instead of re-reading every transcript. Optional: a store that
   * cannot keep tokens (or a write of a Morse-only change, like a rename)
   * omits it, and reconcile simply considers that session changed on the next
   * report.
   */
  write(record: MorseSessionRecord, token?: string): Promise<void>;
  /**
   * The tokens last reported for each session, keyed by Morse id. Optional on
   * purpose: a store that keeps no tokens can never say "unchanged", so a
   * reconcile without it re-writes everything it is given — correct, just not
   * cheap. The map must survive restarts for the skipping to pay off, which is
   * what makes the file store carry tokens in its index rather than deriving
   * them at read time.
   */
  tokens?(): Promise<ReadonlyMap<string, string>>;
  /**
   * Removes one session from the index. Optional on purpose: a store whose
   * backing files live somewhere Morse must not write omits it, and the delete
   * use case then reports that instead of pretending the session is gone.
   */
  remove?(id: string): Promise<void>;
}
