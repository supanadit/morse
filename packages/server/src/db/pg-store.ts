import type { Knex } from 'knex';
import type { MorseSessionRecord } from '@morse/system';
import type { SessionStore } from '@morse/system';

/**
 * The Postgres `SessionStore` for multi-user Morse: the same port the
 * file-backed store serves, over one `morse_sessions` table.
 *
 * Ownership is a constructor argument, not a method argument, so the port and
 * every caller stay unchanged:
 *
 * - `new PgSessionStore(db, userId)` — scoped: every query carries
 *   `WHERE user_id = ?`. New writes land on that user.
 * - `new PgSessionStore(db)` — unscoped (single-user mode): reads span every
 *   user's rows (the union, owner metadata preserved), writes land on the
 *   `'local'` owner for later adoption by the first admin.
 *
 * `refreshExternal` is a no-op: Postgres already is the shared truth, so there
 * is no file polling to redo.
 */

/** Owner for writes while no user scopes them (single-user mode). */
export const LOCAL_OWNER = 'local';

interface SessionRow {
  user_id: string;
  morse_id: string;
  title: string;
  title_pinned: boolean | null;
  cwd: string;
  engine: string;
  engine_session_id: string;
  file: string | null;
  created_at: string | number;
  updated_at: string | number;
  message_count: number;
  parent_id: string | null;
  subagent: boolean | null;
  token: string | null;
}

export class PgSessionStore implements SessionStore {
  constructor(
    private readonly db: Knex,
    private readonly userId?: string,
  ) {}

  private scoped(table: Knex.QueryBuilder): Knex.QueryBuilder {
    return this.userId === undefined ? table : table.where({ user_id: this.userId });
  }

  async list(): Promise<MorseSessionRecord[]> {
    const rows = await this.scoped(this.db('morse_sessions').select('*')).orderBy('updated_at', 'desc');
    return (rows as SessionRow[]).map(toRecord);
  }

  async read(id: string): Promise<MorseSessionRecord | undefined> {
    // Scoped: the composite key is exact. Unscoped: one morse id may exist for
    // several owners (same engine session adopted twice) — newest write wins,
    // the same row the sidebar's union lists first.
    const row = await this.scoped(
      this.db('morse_sessions').select('*').where({ morse_id: id }),
    )
      .orderBy('updated_at', 'desc')
      .first();
    return row === undefined ? undefined : toRecord(row as SessionRow);
  }

  async write(record: MorseSessionRecord, token?: string): Promise<void> {
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('A session record needs an id to be stored.');
    }
    const owner = this.userId ?? LOCAL_OWNER;
    // A write without a token is a Morse-only change (a rename): keep the last
    // engine-reported token, exactly like the file store does.
    const current =
      token === undefined
        ? await this.db('morse_sessions')
            .select('token')
            .where({ user_id: owner, morse_id: id })
            .first()
        : undefined;
    const row = toRow(owner, record, token ?? (current as { token?: string | null } | undefined)?.token ?? null);
    await this.db('morse_sessions').insert(row).onConflict(['user_id', 'morse_id']).merge();
  }

  async remove(id: string): Promise<void> {
    // Scoped: only this owner's row goes. Unscoped: every owner's row for the
    // id goes — single-user delete means gone for everyone.
    await this.scoped(this.db('morse_sessions').where({ morse_id: id })).delete();
  }

  async tokens(): Promise<ReadonlyMap<string, string>> {
    const rows = await this.scoped(this.db('morse_sessions').select('morse_id', 'token'));
    const tokens = new Map<string, string>();
    for (const row of rows as Array<{ morse_id: string; token: string | null }>) {
      if (row.token !== null) {
        tokens.set(row.morse_id, row.token);
      }
    }
    return tokens;
  }

  async refreshExternal(): Promise<void> {
    // Postgres is already the shared truth across processes — nothing to reload.
  }
}

function toRecord(row: SessionRow): MorseSessionRecord {
  return {
    version: 2,
    id: row.morse_id,
    title: row.title,
    ...(row.title_pinned ? { titlePinned: true as const } : {}),
    cwd: row.cwd,
    engineRef: {
      engine: row.engine,
      sessionId: row.engine_session_id,
      ...(row.file === null ? {} : { file: row.file }),
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: row.message_count,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    ...(row.subagent ? { subagent: true as const } : {}),
  };
}

function toRow(
  userId: string,
  record: MorseSessionRecord,
  token: string | null,
): Record<string, unknown> {
  return {
    user_id: userId,
    morse_id: record.id,
    title: record.title,
    title_pinned: record.titlePinned === true,
    cwd: record.cwd,
    engine: record.engineRef.engine,
    engine_session_id: record.engineRef.sessionId,
    file: record.engineRef.file ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    message_count: record.messageCount,
    parent_id: record.parentId ?? null,
    subagent: record.subagent === true,
    token,
  };
}
