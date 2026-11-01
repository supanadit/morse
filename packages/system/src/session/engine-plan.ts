/**
 * Which engines a host should register, from what it could actually resolve.
 *
 * A frontend offers the engine choice only when the host reports more than one
 * engine, so an engine this machine cannot start must not be reported at all: a
 * machine with only OpenCode otherwise shows a picker whose pi entry fails on
 * the first send. Keeping the rule here means the browser host and the VS Code
 * host cannot drift on it.
 */

/** One engine a host considered, with what it learned while resolving it. */
export interface EngineCandidate {
  /** The stable engine kind (`pi`, `opencode`). */
  kind: string;
  /** True when this machine can actually start the engine. */
  available: boolean;
  /** True for the kind the host's configuration names as its preference. */
  preferred?: boolean;
}

/** One engine the host should register, and whether it is the default. */
export interface PlannedEngine {
  kind: string;
  default: boolean;
}

/**
 * The engines to register: only the ones that resolved, with exactly one
 * default — the preferred kind when it survived, else the first one left.
 *
 * An empty list is a truthful answer, not a failure to handle: the host reports
 * no engine, and the frontend's setup screen names every engine the reader could
 * install (the host sends those separately, see `engineSetup`). Naming one here
 * would blame an engine the reader may not even want.
 */
export function planEngineRegistration(
  candidates: ReadonlyArray<EngineCandidate>,
): PlannedEngine[] {
  const available = candidates.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return [];
  }
  const chosen = available.find((candidate) => candidate.preferred === true) ?? available[0];
  return available.map((candidate) => ({
    kind: candidate.kind,
    default: candidate.kind === chosen.kind,
  }));
}
