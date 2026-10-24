import type { AgentEngineRef, MorseSessionRecord } from './record.js';
import type { SessionScanEntry, SessionSource, SessionStore } from './ports.js';

/**
 * Session reconcile use case: merges what an engine reports with what the index
 * holds, so a session the reader started outside Morse (`pi` in a terminal) still
 * appears in the sidebar.
 */

/**
 * What a reconcile has to do, computed without touching any storage.
 *
 * Returned by `planReconcile` so the whole merge policy is one pure function a
 * test can cover, instead of file I/O and merge logic tangled in a host.
 */
export interface ReconcilePlan {
  /** Records to write: new sessions, or ones whose engine token changed. */
  upserts: MorseSessionRecord[];
  /** Morse ids whose engine storage is gone and that the index must forget. */
  removals: string[];
}

/**
 * Decides what a reconcile writes and forgets.
 *
 * - A scanned entry whose token matches the index is left alone: that is the
 *   common case, and it is what makes reconcile cheap.
 * - A scanned entry with a new token replaces the stored record.
 * - A record from an engine this source covers, absent from the scan, is removed:
 *   the reader deleted the session with the engine, and Morse must not keep
 *   listing a conversation that no longer opens.
 *
 * `tokens` is the index's own map (`id` → last engine token), kept beside the
 * records by the host so the record stays free of engine storage detail. Records
 * of *other* engines are never touched: a source only speaks for its own.
 */
export function planReconcile(
  engine: AgentEngineRef['engine'],
  scanned: readonly SessionScanEntry[],
  records: readonly MorseSessionRecord[],
  tokens: ReadonlyMap<string, string>,
): ReconcilePlan {
  const present = new Set<string>();
  const upserts: MorseSessionRecord[] = [];
  for (const entry of scanned) {
    present.add(entry.record.id);
    if (tokens.get(entry.record.id) !== entry.token) {
      upserts.push(entry.record);
    }
  }
  const removals = records
    .filter((record) => record.engineRef.engine === engine && !present.has(record.id))
    .map((record) => record.id);
  return { upserts, removals };
}

/** What one reconcile did, for the caller's log line and a test's assertion. */
export interface ReconcileResult extends ReconcilePlan {
  /** How many sessions the scan reported, before the plan dropped the unchanged ones. */
  scanned: number;
}

/**
 * Reconciles one engine's storage into the index.
 *
 * The scan is the source of truth for its own engine: a session missing from it
 * is gone, and is removed from the index. Nothing of another engine is read or
 * written, so two adapters can each reconcile while sharing one store.
 *
 * `tokens` is read once and returned updated, so a host can persist it beside the
 * records; keeping it out of `MorseSessionRecord` is what stops an engine's
 * `<mtime>:<size>` from leaking into a shape the frontend sees.
 */
export async function reconcileSessions(deps: {
  source: SessionSource;
  store: SessionStore;
  tokens: ReadonlyMap<string, string>;
  /**
   * Called once per upsert and per removal, so a caller can report progress. A
   * first reconcile of a large catalog is otherwise a silent ten thousand awaits.
   */
  onProgress?: (done: number, total: number) => void;
}): Promise<ReconcileResult> {
  const scanned = await deps.source.scan();
  const records = await deps.store.list();
  const plan = planReconcile(deps.source.engine, scanned, records, deps.tokens);
  const total = plan.upserts.length + plan.removals.length;
  let done = 0;
  const tick = (): void => {
    done += 1;
    deps.onProgress?.(done, total);
  };
  for (const record of plan.upserts) {
    await deps.store.write(record);
    tick();
  }
  for (const id of plan.removals) {
    await deps.store.remove?.(id);
    tick();
  }
  return { ...plan, scanned: scanned.length };
}
