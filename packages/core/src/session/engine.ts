import type {
  AgentGatewayFactory,
  SessionCatalog,
  SessionScanEntry,
  SessionStore,
} from './ports.js';
import { reconcileSessions, type ReconcileResult } from './reconcile.js';

/**
 * The abstract session engine: what every agent harness (pi, OpenCode, …) has in
 * common, so a host wires one engine instead of one adapter's private shape.
 *
 * A class rather than a port interface because two of its members are *behaviour*
 * the engine gets for free: `reconcile()` reads the engine's own storage into the
 * index, and `hasScan` answers whether it has one at all. An interface
 * would push both into every adapter, and they would drift.
 *
 * The hooks are callbacks by design — `scan()` is optional and there is nothing
 * else to implement. An engine that keeps sessions behind a remote API simply
 * does not override it, and the sidebar shows only what the index already holds.
 */
export abstract class SessionEngine {
  /** The `AgentEngineRef.engine` value this engine writes into every record. */
  abstract readonly kind: string;

  /** Creates a gateway for a workspace / persisted session (core port). */
  abstract readonly factory: AgentGatewayFactory;

  /** Reads a workspace's persisted sessions (core port). */
  abstract readonly catalog: SessionCatalog;

  /**
   * Every session this engine currently holds on its own storage. Override to
   * make sessions the reader started outside Morse (`pi` in a terminal) visible
   * in the sidebar.
   *
   * Leave it undefined to opt out: reconcile then does nothing for this engine,
   * instead of reporting every indexed session as deleted.
   */
  scan?(): Promise<SessionScanEntry[]>;

  /** Whether this engine has a `scan()` at all, so `reconcile()` has something to do. */
  get hasScan(): boolean {
    return typeof this.scan === 'function';
  }

  /**
   * Merges this engine's storage into the index.
   *
   * Undefined when the engine has no `scan()` — deliberately distinct from
   * "found nothing", because the latter removes every indexed session of this
   * engine.
   *
   * `onProgress` is called per write, so a host shows the one-off migration of a
   * large catalog instead of a frozen window; without it a first reconcile of ten
   * thousand sessions is ten thousand silent awaits.
   */
  async reconcile(options: {
    store: SessionStore;
    tokens: ReadonlyMap<string, string>;
    onProgress?: (done: number, total: number) => void;
  }): Promise<ReconcileResult | undefined> {
    const scan = this.scan;
    if (scan === undefined) {
      return undefined;
    }
    return reconcileSessions({
      // Bound, so `scan` keeps `this` when the engine overrides it as a method.
      source: { engine: this.kind, scan: () => scan.call(this) },
      store: options.store,
      tokens: options.tokens,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
  }
}
