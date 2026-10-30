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
  /**
   * The token the report carried for each upsert, keyed by the record's Morse
   * id. The caller writes it beside the record, so the *next* reconcile can
   * skip this session again without re-deriving it.
   */
  upsertTokens: ReadonlyMap<string, string>;
  /** Morse ids whose engine storage is gone and that the index must forget. */
  removals: string[];
}

/**
 * Decides what a reconcile writes and forgets.
 *
 * - A reported session whose token matches the index is left alone: that is the
 *   common case, and it is what makes reconcile cheap.
 * - A stored record whose shape version is older than the current one is
 *   rewritten regardless of the token — that is how a Morse upgrade backfills
 *   fields the previous shape never carried (subagent links, say). A session
 *   that never changes again would otherwise keep its stale shape forever.
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
  /**
   * Sessions Morse is running right now. A report that omits one is stale (the
   * engine may still be writing its session file), so its row is never removed:
   * only the engine's *finished* sessions can be declared gone.
   */
  running?: ReadonlySet<string>,
): ReconcilePlan {
  const present = new Set<string>();
  const stored = new Map(records.map((record) => [record.id, record] as const));
  const upserts: MorseSessionRecord[] = [];
  const upsertTokens = new Map<string, string>();
  for (const info of reported) {
    const record = toSessionRecord(kind, info);
    present.add(record.id);
    const unchanged =
      tokens.get(record.id) === info.token && stored.get(record.id)?.version === record.version;
    if (!unchanged) {
      upserts.push(record);
      upsertTokens.set(record.id, info.token);
    }
  }
  const removals = records
    .filter(
      (record) =>
        record.engineRef.engine === kind &&
        !present.has(record.id) &&
        running?.has(record.id) !== true,
    )
    .map((record) => record.id);
  return { upserts, upsertTokens, removals };
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
  /**
   * The tokens of the sessions already indexed, keyed by Morse id — used only
   * when the store itself cannot report them (`store.tokens` absent). The store
   * is preferred: it is where the last write kept them, so its map is the one
   * that survives restarts, while a caller-held map is the host's own memory of
   * it. Without either, every reported session is treated as changed, which is
   * correct — only not cheap.
   */
  tokens?: ReadonlyMap<string, string>;
  /**
   * Sessions this process is running. Their rows are never removed by a report
   * that does not mention them: an engine may not have flushed a live session to
   * the storage the report reads, and a session in front of the reader cannot be
   * deleted by a snapshot taken mid-write.
   */
  running?: ReadonlySet<string>;
  /**
   * Called once per upsert and per removal, so a caller can report progress. A
   * first reconcile of a large catalog is otherwise a silent ten thousand awaits.
   */
  onProgress?: (done: number, total: number) => void;
}): Promise<ReconcileResult> {
  const reported = await deps.scan();
  const records = await deps.store.list();
  const tokens = (await deps.store.tokens?.()) ?? deps.tokens ?? new Map<string, string>();
  const plan = planReconcile(deps.kind, reported, records, tokens, deps.running);
  const total = plan.upserts.length + plan.removals.length;
  let done = 0;
  const tick = (): void => {
    done += 1;
    deps.onProgress?.(done, total);
  };
  for (const record of plan.upserts) {
    await deps.store.write(record, plan.upsertTokens.get(record.id));
    tick();
  }
  for (const id of plan.removals) {
    await deps.store.remove?.(id);
    tick();
  }
  return { ...plan, reported: reported.length };
}
