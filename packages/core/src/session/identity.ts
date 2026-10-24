import type { AgentEngineRef } from './record.js';

/**
 * Morse's session id, derived from what the engine calls the session.
 *
 * Derived, not generated, on purpose. Two hosts can discover the same session the
 * reader started with the `pi` CLI — the VS Code window and the browser server —
 * and if each minted its own UUID they would list that conversation twice. A
 * derivation gives both the same id with no coordination, no lock and no shared
 * counter, so "one writer per directory" stops being a requirement.
 *
 * Hashed rather than concatenated because the id becomes a file name under
 * `<data dir>/sessions/`: an engine id is free to contain `/`, `:` or anything
 * else a filesystem rejects, and a shard path must not inherit that.
 *
 * FNV-1a, twice with different seeds, for 64 bits. This is an identity, not a
 * security boundary: a collision would need two *different* engine sessions to
 * land on the same 64 bits, which at ten thousand sessions is about one in a
 * trillion. `crypto` is deliberately not used — it would drag a Node (or a DOM)
 * type into a package that must stay buildable with neither.
 */
export function deriveSessionId(engineRef: Pick<AgentEngineRef, 'engine' | 'sessionId'>): string {
  const key = `${engineRef.engine}\u0000${engineRef.sessionId}`;
  return `${fnv1a(key, 0x811c9dc5).toString(36).padStart(7, '0')}${fnv1a(key, 0x01000193)
    .toString(36)
    .padStart(7, '0')}`;
}

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
