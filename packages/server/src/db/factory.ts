import knex from 'knex';
import type { Knex } from 'knex';
import { FileSessionStore, type MorseLogger, type SessionStore } from '@morse/system';
import { join } from 'node:path';
import type { MorseServerConfig } from '../app/config.js';
import { latestSchemaVersion, migrateToLatest } from './migrations.js';
import { LOCAL_OWNER, PgSessionStore } from './pg-store.js';
import { countUsers, earliestAdminId } from './users.js';

/**
 * Multi-user session storage for the `morse-web` host.
 *
 * Only this host calls it, and only when `multiuser` is on: the file index
 * stays the default everywhere else (including `server` dev). The database is
 * fully automatic — the operator provides five `MORSE_PG_*` values and this
 * connects, migrates to the latest schema and adopts the old file sessions
 * into the earliest admin on first boot with users.
 */

/** Which `MORSE_PG_*` knobs are missing, for the loud boot error. */
function missingPgEnv(config: MorseServerConfig): string[] {
  const missing: string[] = [];
  if (config.pgHost === undefined) missing.push('MORSE_PG_HOST');
  if (config.pgUser === undefined) missing.push('MORSE_PG_USER');
  if (config.pgPassword === undefined) missing.push('MORSE_PG_PASSWORD');
  if (config.pgDatabase === undefined) missing.push('MORSE_PG_DATABASE');
  return missing;
}

async function metaGet(db: Knex, key: string): Promise<string | undefined> {
  const row = await db('morse_meta').where({ key }).first();
  return row === undefined ? undefined : String((row as { value: string }).value);
}

async function metaSet(db: Knex, key: string, value: string): Promise<void> {
  await db('morse_meta').insert({ key, value }).onConflict('key').merge();
}

/**
 * Adopts the file-backed sessions (`<dataDir>/sessions`) into Postgres once.
 * Old rows become owned by the earliest admin (or the `'local'` owner when no
 * user exists yet — the first admin's creation re-runs adoption and moves
 * them). File rows are authoritative over unscoped pg writes of the same
 * conversation, so `'local'` duplicates are replaced, never doubled.
 */
export async function adoptFileSessions(
  db: Knex,
  dataDir: string,
  logger: MorseLogger,
): Promise<{ adopted: number; owner: string } | undefined> {
  if ((await metaGet(db, 'adopted_file_sessions')) === '1') {
    return undefined;
  }
  const files = new FileSessionStore(join(dataDir, 'sessions'));
  const records = await files.list();
  if (records.length === 0) {
    await metaSet(db, 'adopted_file_sessions', '1');
    return undefined;
  }
  const users = await countUsers(db);
  const owner = users === 0 ? LOCAL_OWNER : ((await earliestAdminId(db)) ?? LOCAL_OWNER);
  const tokens = await files.tokens().catch(() => new Map<string, string>());
  const store = new PgSessionStore(db, owner);
  let adopted = 0;
  for (const record of records) {
    const existing = await store.read(record.id);
    if (existing !== undefined) {
      continue;
    }
    await store.write(record, tokens.get(record.id));
    adopted += 1;
  }
  // Whatever `owner` the unscoped host wrote before adoption is superseded by
  // the file rows just adopted for the same conversations.
  if (owner !== LOCAL_OWNER) {
    const adoptedIds = records.map((record) => record.id);
    for (let index = 0; index < adoptedIds.length; index += 500) {
      await db('morse_sessions')
        .where({ user_id: LOCAL_OWNER })
        .whereIn('morse_id', adoptedIds.slice(index, index + 500))
        .delete();
    }
  }
  await metaSet(db, 'adopted_file_sessions', '1');
  logger.info(`Adopted ${adopted} file session(s) into multi-user storage (owner: ${owner}).`);
  return { adopted, owner };
}

/**
 * Moves every `'local'`-owned row (written while no user existed) into a
 * real user. Called once when the first admin is created, so the wizard's
 * sessions and the pre-login adoption land on the admin, not on a placeholder.
 */
export async function adoptLocalRowsToUser(db: Knex, userId: string): Promise<number> {
  const moved = await db('morse_sessions').where({ user_id: LOCAL_OWNER }).update({ user_id: userId });
  return moved;
}

/**
 * Whether Postgres settings are present at all. Single-user hosts with a
 * database configured still use it — unscoped, the union of every owner's
 * rows — so flipping `multiuser` off shows all sessions instead of an empty
 * file index. Owner metadata stays on the rows for the flip back.
 */
export function pgConfigured(config: MorseServerConfig): boolean {
  return missingPgEnv(config).length === 0;
}

/**
 * Opens the database handle (connect only — no schema work). One handle per
 * host, shared by the session store, the per-user routers and the auth
 * controller. Undefined when neither `multiuser` is on nor `MORSE_PG_*` is
 * configured (the file index stays). Throws loudly when `multiuser` is on
 * but unreachable or unconfigured.
 */
export async function openMultiuserDb(config: MorseServerConfig): Promise<Knex | undefined> {
  if (!pgConfigured(config) && !config.multiuser) {
    return undefined;
  }
  const missing = missingPgEnv(config);
  if (missing.length > 0) {
    throw new Error(
      `Multi-user mode needs PostgreSQL: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        `Provide MORSE_PG_HOST, MORSE_PG_PORT (default 5432), MORSE_PG_USER, MORSE_PG_PASSWORD and MORSE_PG_DATABASE.`,
    );
  }
  const db = knex({
    client: 'pg',
    connection: {
      host: config.pgHost,
      port: config.pgPort,
      user: config.pgUser,
      password: config.pgPassword,
      database: config.pgDatabase,
    },
    pool: { min: 0, max: 10 },
  });
  try {
    await db.raw('select 1');
  } catch (error: unknown) {
    await db.destroy().catch(() => undefined);
    throw new Error(
      `Cannot reach PostgreSQL at ${config.pgHost}:${config.pgPort}/${config.pgDatabase} as ${config.pgUser}. ` +
        `Check MORSE_PG_* and that the database exists.`,
      { cause: error },
    );
  }
  return db;
}

/**
 * The multi-user session store over an open handle: migrated and backfilled
 * before anything reads it. Unscoped until login lands — the union of all
 * owners, writes to `'local'` — which is the same visible behavior as the
 * file index, on Postgres.
 */
export async function createMultiuserSessionStore(
  db: Knex,
  config: MorseServerConfig,
  logger: MorseLogger,
): Promise<SessionStore> {
  await migrateToLatest(db, logger);
  logger.info(`Multi-user session storage ready (schema v${latestSchemaVersion()}).`);
  await adoptFileSessions(db, config.dataDir, logger);
  return new PgSessionStore(db);
}

