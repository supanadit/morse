import type { Knex } from 'knex';
import type { MorseLogger } from '@morse/system';

/**
 * Versioned Postgres schema for multi-user Morse, applied by knex at boot.
 *
 * Migrations live in code (not `knex migrate` files) on purpose: the server
 * ships as one bundled `server.mjs`, so there is no migration directory on disk
 * at runtime. The guarantees are the same — ordered, transactional, stamped in
 * `morse_meta.schema_version`, resumable after a crash — without a file loader.
 */

const META_KEY = 'schema_version';

interface Migration {
  version: number;
  name: string;
  up: (db: Knex) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'users and sessions',
    up: async (db) => {
      await db.schema.createTableIfNotExists('morse_users', (table) => {
        table.text('id').primary();
        table.text('username').notNullable().unique();
        table.text('password_hash').notNullable();
        table.text('role').notNullable().defaultTo('regular');
        table.bigInteger('created_at').notNullable();
      });
      await db.schema.createTableIfNotExists('morse_sessions', (table) => {
        // `user_id` is deliberately *not* a foreign key: it is owner metadata
        // that outlives strict references — the `'local'` placeholder owns rows
        // before any user exists, and single-user mode keeps every owner's
        // rows after users are deleted. `deleteUser` removes rows explicitly.
        table.text('user_id').notNullable();
        table.text('morse_id').notNullable();
        table.text('title').notNullable();
        table.boolean('title_pinned').nullable();
        table.text('cwd').notNullable();
        table.text('engine').notNullable();
        table.text('engine_session_id').notNullable();
        table.text('file').nullable();
        table.bigInteger('created_at').notNullable();
        table.bigInteger('updated_at').notNullable();
        table.integer('message_count').notNullable().defaultTo(0);
        table.text('parent_id').nullable();
        table.boolean('subagent').nullable();
        // The engine-reported token beside the record (see `SessionStore`):
        // reconcile's unchanged-skipping must survive restarts.
        table.text('token').nullable();
        table.primary(['user_id', 'morse_id']);
      });
      await db.schema.raw(
        'CREATE INDEX IF NOT EXISTS morse_sessions_user_cwd_updated ON morse_sessions (user_id, cwd, updated_at DESC)',
      );
    },
  },
  {
    version: 2,
    name: 'login tokens',
    up: async (db) => {
      // One row per login session: the sha256 of the cookie token (deterministic
      // lookup, no plaintext), its owner and expiry. Logout deletes the row.
      await db.schema.createTableIfNotExists('morse_tokens', (table) => {
        table.text('token_hash').primary();
        table.text('user_id').notNullable();
        table.bigInteger('created_at').notNullable();
        table.bigInteger('expires_at').notNullable();
      });
      await db.schema.raw(
        'CREATE INDEX IF NOT EXISTS morse_tokens_user ON morse_tokens (user_id)',
      );
    },
  },
  {
    version: 3,
    name: 'user profile fields',
    up: async (db) => {
      // Additive only: existing rows keep working, with the username standing in
      // as the display name until an admin edits the profile.
      await db.schema.alterTable('morse_users', (table) => {
        table.text('name').notNullable().defaultTo('');
        table.text('email').notNullable().defaultTo('');
      });
    },
  },
  {
    version: 4,
    name: 'oidc provider and links',
    up: async (db) => {
      // JIT-provisioned SSO users link back to their provider here; local
      // logins leave both null. Not a foreign key on purpose, like `user_id`.
      const hasSub = await db.schema.hasColumn('morse_users', 'oidc_sub');
      if (!hasSub) {
        await db.schema.alterTable('morse_users', (table) => {
          table.text('oidc_sub').nullable();
          table.text('oidc_issuer').nullable();
        });
      }
      // Single-row provider config for UI-managed OIDC (`id` always 'default').
      // Env-managed hosts never read it; the secret stays plaintext like every
      // other host secret in this database (it comes back to an admin's browser).
      await db.schema.createTableIfNotExists('morse_oidc_config', (table) => {
        table.text('id').primary();
        table.integer('enabled').notNullable().defaultTo(0);
        table.text('display_name').notNullable().defaultTo('Single sign-on');
        table.text('discovery_url').nullable();
        table.text('auth_url').nullable();
        table.text('token_url').nullable();
        table.text('userinfo_url').nullable();
        table.text('end_session_url').nullable();
        table.text('client_id').nullable();
        table.text('client_secret').nullable();
        table.text('scopes').notNullable().defaultTo('openid profile email');
        table.integer('allow_signup').notNullable().defaultTo(1);
        table.bigInteger('updated_at').notNullable();
      });
    },
  },
  {
    version: 5,
    name: 'sso login sessions',
    up: async (db) => {
      // Marks which login sessions came through SSO: their logout bounces via
      // the provider's end-session endpoint, while password logins end locally.
      const hasOidc = await db.schema.hasColumn('morse_tokens', 'oidc');
      if (!hasOidc) {
        await db.schema.alterTable('morse_tokens', (table) => {
          table.integer('oidc').notNullable().defaultTo(0);
        });
      }
    },
  },
];

/**
 * Brings the connected database to the latest schema. Safe to run on every
 * boot: applied versions are skipped, a missing version runs once inside its
 * own transaction, and the stamp lands only after its migration commits.
 */
export async function migrateToLatest(db: Knex, logger: MorseLogger): Promise<void> {
  if (!(await db.schema.hasTable('morse_meta'))) {
    await db.schema.createTable('morse_meta', (table) => {
      table.text('key').primary();
      table.text('value').notNullable();
    });
  }
  const row = await db('morse_meta').where({ key: META_KEY }).first();
  const current = row === undefined ? 0 : Number.parseInt(String(row.value), 10) || 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    logger.info(`Migrating multi-user database to v${migration.version} (${migration.name})`);
    await db.transaction(async (trx) => {
      await migration.up(trx);
      await trx('morse_meta')
        .insert({ key: META_KEY, value: String(migration.version) })
        .onConflict('key')
        .merge();
    });
  }
}

/** Latest schema version this build knows, for logs and health probes. */
export function latestSchemaVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}
