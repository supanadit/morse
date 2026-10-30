import {
  DEFAULT_SESSION_SEARCH_LIMIT,
  DEFAULT_SESSIONS_PER_PROJECT,
  UNTITLED_SESSION,
  type SessionCatalog,
  type SessionPage,
  type SessionSummary,
} from "@morse/system";
import type { OpenCodeApi } from "./internal/client.js";
import type { ApiSessionInfo } from "./opencode-agent.js";

/**
 * OpenCode's stored sessions as a Morse catalog.
 *
 * OpenCode pages its whole session list newest-first, with the project directory
 * on each row; Morse's sidebar is grouped by that directory and paged per
 * project. So this catalog reads the list (a few pages at most, bounded) and does
 * the grouping itself — the server has no per-directory listing to ask for.
 *
 * Archived sessions are left out when the server marks them (the installed 2.1.4
 * does not, but a stored row may carry the flag): an archived conversation is not
 * something the sidebar should offer to resume.
 *
 * `id` is the engine's own session id, exactly like pi's catalog: deriving Morse's
 * id is the application's job, and keeping the engine id here is what makes
 * `remove(id)` unambiguous.
 */

const SESSION_PAGE_SIZE = 200;
/** A bound on how many pages a full read walks, so a bad cursor cannot loop forever. */
const MAX_SESSION_PAGES = 50;

/** The fields of a `Session.Info` the catalog reads beyond the agent's own. */
interface CatalogSessionInfo extends ApiSessionInfo {
  archived?: boolean;
}

export interface OpenCodeSessionCatalogOptions {
  api: OpenCodeApi;
  /** Sessions one project shows in a first list (the sidebar's "Load more" cap). */
  maxSessionsPerProject?: number;
  /** Optional ceiling on the whole list; unlimited when omitted. */
  maxSessions?: number;
}

export class OpenCodeSessionCatalog implements SessionCatalog {
  private readonly maxPerProject: number;
  private readonly maxSessions: number;

  constructor(private readonly options: OpenCodeSessionCatalogOptions) {
    // A non-positive page size would make the sidebar show nothing; clamp to one.
    this.maxPerProject = Math.max(
      1,
      Math.trunc(options.maxSessionsPerProject ?? DEFAULT_SESSIONS_PER_PROJECT),
    );
    this.maxSessions =
      options.maxSessions === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, Math.trunc(options.maxSessions));
  }

  /** Every project's first page, newest first. */
  async list(): Promise<SessionSummary[]> {
    const sessions = await this.allSessions();
    const shown = new Map<string, number>();
    const summaries: SessionSummary[] = [];
    for (const session of sortNewestFirst(sessions)) {
      const summary = toSummary(session);
      const seen = shown.get(summary.cwd) ?? 0;
      if (seen >= this.maxPerProject) {
        continue;
      }
      shown.set(summary.cwd, seen + 1);
      summaries.push(summary);
    }
    return summaries.slice(0, this.maxSessions);
  }

  /** More of one project's sessions, newest first, starting at `offset`. */
  async listPage(options: {
    cwd: string;
    offset?: number;
    limit?: number;
  }): Promise<SessionPage> {
    const sessions = sortNewestFirst(await this.allSessions()).filter(
      (session) => session.location?.directory === options.cwd,
    );
    const start = Math.max(0, options.offset ?? this.maxPerProject);
    const limit = Math.max(1, options.limit ?? this.maxPerProject);
    return {
      sessions: sessions.slice(start, start + limit).map(toSummary),
      hasMore: start + limit < sessions.length,
    };
  }

  /** Sessions whose title or project path contains the query. */
  async search(
    query: string,
    limit: number = DEFAULT_SESSION_SEARCH_LIMIT,
  ): Promise<SessionSummary[]> {
    const needle = query.toLowerCase();
    return sortNewestFirst(await this.allSessions())
      .filter((session) => {
        const summary = toSummary(session);
        return (
          summary.title.toLowerCase().includes(needle) ||
          summary.cwd.toLowerCase().includes(needle)
        );
      })
      .slice(0, limit)
      .map(toSummary);
  }

  /** True session count per project directory. */
  async countByProject(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const session of await this.allSessions()) {
      const cwd = session.location?.directory;
      if (cwd === undefined || cwd.length === 0) {
        continue;
      }
      counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    }
    return counts;
  }

  /** Deletes one session and its conversation. */
  async remove(id: string): Promise<void> {
    await this.options.api.delete(`/session/${encodeURIComponent(id)}`);
  }

  /** Every stored session, newest first, walking the server's cursor. */
  async allSessions(): Promise<CatalogSessionInfo[]> {
    const sessions: CatalogSessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
      const result = await this.options.api.page<CatalogSessionInfo>(
        "/session",
        {
          limit: String(SESSION_PAGE_SIZE),
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      for (const session of result.data) {
        if (typeof session.id !== "string" || session.id.length === 0) {
          continue;
        }
        if (isArchived(session)) {
          continue;
        }
        sessions.push(session);
      }
      cursor = result.cursor?.next ?? undefined;
      if (cursor === undefined) {
        break;
      }
    }
    return sessions;
  }
}

/** A stored session as the sidebar row Morse shows for an engine catalog. */
function toSummary(session: CatalogSessionInfo): SessionSummary {
  const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
  // A `task` child (a subagent) and a fork both nest under their parent, but
  // only a subagent is a read-only watcher: a fork is a conversation the user
  // branched and keeps prompting in. OpenCode separates them on the record —
  // `parentID` for delegation children, `fork.sessionID` for forks — and a
  // parent can have any number of either, running in parallel.
  const isSubagent =
    session.parentID !== undefined && session.parentID.length > 0;
  return {
    id: session.id,
    title:
      session.title !== undefined && session.title.length > 0
        ? session.title
        : UNTITLED_SESSION,
    cwd: session.location?.directory ?? "",
    updatedAt,
    // OpenCode's session record carries no message count; the transcript counts
    // what it replays. Zero says "not reported" rather than inventing a number.
    messageCount: 0,
    ...(isSubagent
      ? { parentId: session.parentID, subagent: true }
      : session.fork?.sessionID === undefined
        ? {}
        : { parentId: session.fork.sessionID }),
  };
}

function sortNewestFirst(
  sessions: readonly CatalogSessionInfo[],
): CatalogSessionInfo[] {
  return [...sessions].sort(
    (left, right) =>
      (right.time?.updated ?? right.time?.created ?? 0) -
      (left.time?.updated ?? left.time?.created ?? 0),
  );
}

function isArchived(session: CatalogSessionInfo): boolean {
  return (
    session.archived === true ||
    (session.time?.archived !== undefined && session.time.archived > 0)
  );
}
