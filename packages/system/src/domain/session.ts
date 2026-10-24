/**
 * The session and project vocabulary: how a session is listed, and how a project
 * groups sessions. Both are Morse's shapes — a harness supplies the data, but a
 * sidebar page is Morse's.
 *
 * Shapes only — no I/O, no ports, no framework imports (R2/R8).
 */

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  messageCount: number;
  /**
   * The session this one was forked from, as its id, when pi recorded one. A child
   * and its parent share a first message, so this is the only thing that tells a
   * fork from a coincidence — the frontend nests a child under its parent by it.
   * Mirrors `SessionSummary` in `@morse/protocol`.
   */
  parentId?: string;
}

/** A project is a directory the agent has worked in (one pi session bucket). */
export interface ProjectSummary {
  path: string;
  name: string;
  sessionCount: number;
  lastUsedAt: number;
}
