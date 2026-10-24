import type { AgentGatewayFactory, AgentHistoryPage } from './ports.js';
import type { WorkspaceRef } from './domain/index.js';

/**
 * What a harness knows about one of its own sessions, in its own terms.
 *
 * Deliberately free of any application type: `sessionId` is the harness's id, not
 * Morse's. Turning this into a Morse session record — deriving the id, the parent
 * link and the title fallback — is the application's job, which is what keeps this
 * package compilable with no dependencies.
 */
export interface AgentSessionInfo {
  /** The id the harness's own storage uses for this session. */
  sessionId: string;
  /**
   * Where the harness persists the conversation, when it persists one. Absent for
   * a harness that keeps history in memory or behind a remote API. Nothing above an
   * adapter reads it.
   */
  file?: string;
  /** The name the harness reports, when it reports one. */
  title?: string;
  /** The directory the session works in. */
  cwd: string;
  /** When the session began. Absent when the harness does not record it. */
  createdAt?: number;
  /** When the session last changed, in epoch milliseconds. */
  updatedAt: number;
  /** How many messages the session holds, as the harness counts them. */
  messageCount: number;
  /** The harness's own id for the session this one was forked from, when it records one. */
  parentSessionId?: string;
  /**
   * An opaque marker for "this session has not changed since the last report".
   * Comparing it lets a caller skip reading a huge transcript. Typically
   * `<mtime>:<size>` or a revision number — the format is the harness's business.
   */
  token: string;
}

/**
 * The abstract session engine: what every agent harness (pi, OpenCode, …) has in
 * common, so a host wires one engine instead of one adapter's private shape.
 *
 * It declares only what it owns: the harness kind, the factory that creates
 * sessions, and the optional report of the sessions it already holds. A session
 * *catalog* and a session *store* are the application's, so they live on the
 * application-side composite instead — otherwise this package would have to import
 * the application package, and the two would be one package with two names.
 *
 * The hooks are callbacks by design — `scan()` is optional and there is nothing
 * else to implement. An engine that keeps sessions behind a remote API simply does
 * not override it.
 */
export abstract class SessionEngine {
  /**
   * The kind that identifies this harness in a session record (`'pi'`,
   * `'opencode'`). A resumed session is handed back to the same kind.
   */
  abstract readonly kind: string;

  /** Creates a session for a workspace, or resumes a persisted one. */
  abstract readonly factory: AgentGatewayFactory;

  /**
   * Every session this engine currently holds on its own storage. Override to make
   * sessions the reader started outside Morse visible in the sidebar.
   *
   * Leave it undefined to opt out: a caller then does nothing for this engine,
   * instead of reporting every indexed session as deleted.
   */
  scan?(): Promise<AgentSessionInfo[]>;

  /** Whether this engine has a `scan()` at all, so a caller has something to merge. */
  get hasScan(): boolean {
    return typeof this.scan === 'function';
  }
}

/**
 * A history page for one session, re-exported here so an adapter implementing
 * `SessionEngine` needs one import fewer.
 */
export type { AgentHistoryPage };

/**
 * The workspace an engine is asked to work in, re-exported for the same reason.
 */
export type { WorkspaceRef };
