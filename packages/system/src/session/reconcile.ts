import type { AgentSessionInfo } from '@morse/agent';
import { toSessionRecord, type MorseSessionRecord } from './record.js';
import type { SessionStore } from './ports.js';

/**
 * Session reconcile use case: merges what a harness reports with what the index
 * holds, so a session the reader started outside Morse (`pi` in a terminal) still
 * appears in the sidebar.
 *
 * A harness reports `AgentSessionInfo` — its own terms. Turning that into a Morse
 * record, including deriving the id, is `toSessionRecord`'s job, so nothing here
 * needs a harness to know Morse's id scheme.
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
 * - A reported session whose token matches the index is left alone: that is the
 *   common case, and it is what makes reconcile cheap.
 * - A reported session with a new token replaces the stored record.
 * - A record from the engine this source covers, absent from the report, is
 *   removed: the reader deleted the session with the harness, and Morse must not
 *   keep listing a conversation that no longer opens.
 *
 * `tokens` is the index's own map (`id` → last report token), kept beside the
 * records by the host so the record stays free of harness storage detail. Records
 * of *other* engines are never touched: a report only speaks for its own.
 */
export function planReconcile(
  kind: string,
  reported: readonly AgentSessionInfo[],
  records: readonly MorseSessionRecord[],
  tokens: ReadonlyMap<string, string>,
): ReconcilePlan {
  const present = new Set<string>();
  const upserts: MorseSessionRecord[] = [];
  for (const info of reported) {
    const record = toSessionRecord(kind, info);
    present.add(record.id);
    if (tokens.get(record.id) !== info.token) {
      upserts.push(record);
    }
  }
  const removals = records
    .filter((record) => record.engineRef.engine === kind && !present.has(record.id))
    .map((record) => record.id);
  return { upserts, removals };
}

/** What one reconcile did, for the caller's log line and a test's assertion. */
export interface ReconcileResult extends ReconcilePlan {
  /** How many sessions the report carried, before the plan dropped the unchanged ones. */
  reported: number;
}

/**
 * Reconciles one harness's storage into the index.
 *
 * The report is the source of truth for its own engine: a session missing from it
 * is gone, and is removed from the index. Nothing of another engine is read or
 * written, so two adapters can each reconcile while sharing one store.
 *
 * `onProgress` is called per write, so a host shows the one-off migration of a
 * large catalog instead of a frozen window; without it a first reconcile of ten
 * thousand sessions is ten thousand silent awaits.
 */
export async function reconcileSessions(deps: {
  kind: string;
  scan: () => Promise<readonly AgentSessionInfo[]>;
  store: SessionStore;
  tokens: ReadonlyMap<string, string>;
  /**
   * Called once per upsert and per removal, so a caller can report progress. A
   * first reconcile of a large catalog is otherwise a silent ten thousand awaits.
   */
  onProgress?: (done: number, total: number) => void;
}): Promise<ReconcileResult> {
  const reported = await deps.scan();
  const records = await deps.store.list();
  const plan = planReconcile(deps.kind, reported, records, deps.tokens);
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
  return { ...plan, reported: reported.length };
}
