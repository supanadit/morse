import type { AgentGatewayFactory, SessionEngine } from '@morse/agent';
import type { SessionCatalog } from './ports.js';

/**
 * Everything a host needs from one harness, in one value.
 *
 * A composite rather than members on `SessionEngine` because `SessionCatalog` is
 * Morse's: declaring it on an engine that lives in `@morse/agent` would make that
 * package import `@morse/system`, and the two packages would be one package with
 * two names. The engine stays the harness's own (kind, factory, `scan?()`); the
 * catalog joins it here, on Morse's side of the boundary.
 *
 * A host obtains `factory` and `catalog` from the adapter it constructed — which
 * is what both composition roots already do — and the engine is carried alongside
 * them so `reconcile()` can reach `scan()`.
 */
export interface AgentIntegration {
  /** The harness: its kind and, when it can, a report of the sessions it holds. */
  readonly engine: SessionEngine;
  /** Creates a session for a workspace, or resumes a persisted one. */
  readonly factory: AgentGatewayFactory;
  /** Reads a workspace's persisted sessions, for the sidebar. */
  readonly catalog: SessionCatalog;
}
