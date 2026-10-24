import type { SessionSummary } from '../domain.js';

/**
 * Domain shapes for a Morse session record.
 *
 * Data only: no I/O, no ports, no engine imports (clean-architecture R2). What a
 * record *is* belongs here; how it is stored belongs in `ports.ts`, and how two
 * records are merged belongs in `reconcile.ts`.
 */

/**
 * Which agent engine a session belongs to, and what that engine calls it.
 *
 * Morse owns the session record; the engine owns the conversation. Keeping the
 * engine's own identifiers in one opaque bag is what lets a second engine
 * (OpenCode) be added without the index, the sidebar or the frontend learning a
 * single engine-specific field name. Nothing outside an adapter reads `file`:
 * it is a path, and a path is the engine's business.
 */
export interface AgentEngineRef {
  /**
   * The adapter kind that created the session (`'pi'`, `'opencode'`). A resumed
   * session is handed back to the same kind, so a host with both installed can
   * still reopen a session it did not create.
   */
  engine: string;
  /** The engine's session id: stable while the engine keeps the session. */
  sessionId: string;
  /**
   * Where the engine persists the conversation, when it persists one. Absent for
   * an engine that keeps history in memory or behind a remote API. Never read by
   * the frontend and never trusted as an id.
   */
  file?: string;
}

/**
 * A session as Morse records it: everything the sidebar, the tabs and a resume
 * need, and nothing about how the conversation is stored.
 *
 * This is the record persisted under `<data dir>/sessions/`, the one-file-per-
 * session form, so it is deliberately flat and small enough to read a thousand
 * of. The transcript is *not* here: it stays with the engine (see `engineRef.file`).
 */
export interface MorseSessionRecord {
  /** Shape version of this record, so a later Morse can migrate instead of guess. */
  version: 1;
  /**
   * Morse's own id, derived by `deriveSessionId` and not by the engine. It is the
   * registry key, the transcript key and the frontend's tab id, so it must be the
   * same on every host that sees the same engine session — otherwise the VS Code
   * window and the browser server would list the same conversation twice.
   */
  id: string;
  /** The name the sidebar shows. Morse owns it, so a rename never starts an engine. */
  title: string;
  /** The directory the session works in, which is how the sidebar groups sessions. */
  cwd: string;
  engineRef: AgentEngineRef;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /**
   * The session this one was forked from, as a Morse id (not an engine id). A
   * child and its parent share a first message, so this is the only thing that
   * tells a fork from a coincidence.
   */
  parentId?: string;
}

/** The placeholder a session shows before its first prompt names it. */
export const UNTITLED_SESSION = 'Untitled session';

/**
 * The `SessionSummary` the sidebar and the wire use, projected from a record.
 *
 * A projection rather than a second stored shape: the record already holds every
 * field, and two persisted shapes would drift the moment one gains a field.
 */
export function toSessionSummary(record: MorseSessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    cwd: record.cwd,
    updatedAt: record.updatedAt,
    messageCount: record.messageCount,
    ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
  };
}
