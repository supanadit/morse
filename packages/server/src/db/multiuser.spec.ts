import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';
import { newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionStore, silentLogger, type MorseSessionRecord } from '@morse/system';
import { migrateToLatest } from './migrations.js';
import { LOCAL_OWNER, PgSessionStore } from './pg-store.js';
import {
  countUsers,
  createUser,
  deleteUser,
  earliestAdminId,
  listUsers,
  setUserRole,
  verifyUser,
} from './users.js';
import { adoptFileSessions, adoptLocalRowsToUser } from './factory.js';

/**
 * The multi-user Postgres layer, against an in-memory pg (`pg-mem`): schema
 * migrations, users/roles, scoped vs unscoped session reads, and the one-time
 * file adoption. No live database needed — the SQL is the same knex emits.
 */
describe('multi-user storage', () => {
  let db: Knex;

  beforeEach(async () => {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    db = mem.adapters.createKnex(0, { client: 'pg' }) as unknown as Knex;
    await migrateToLatest(db, silentLogger);
  });

  afterEach(async () => {
    await db.destroy().catch(() => undefined);
  });

  it('migrates idempotently: a second run applies nothing', async () => {
    await migrateToLatest(db, silentLogger);
    const rows = await db('morse_meta').select('*');
    expect(rows).toHaveLength(1);
  });

  it('forces the first user to admin and defaults later users to regular', async () => {
    const first = await createUser(db, { username: 'Adit', password: 'supersecret', role: 'regular' });
    expect(first.role).toBe('admin');
    expect(first.username).toBe('adit');
    const second = await createUser(db, { username: 'bob', password: 'supersecret' });
    expect(second.role).toBe('regular');
    expect(await countUsers(db)).toBe(2);
  });

  it('rejects duplicates, short passwords, bad logins and unsafe usernames', async () => {
    await createUser(db, { username: 'adit', password: 'supersecret' });
    await expect(createUser(db, { username: 'Adit', password: 'anothersecret' })).rejects.toThrow(/already exists/);
    await expect(createUser(db, { username: 'new', password: 'short' })).rejects.toThrow(/8 characters/);
    await expect(createUser(db, { username: '../evil', password: 'supersecret' })).rejects.toThrow(/a-z, 0-9/);
    await expect(createUser(db, { username: 'a/b', password: 'supersecret1' })).rejects.toThrow(/a-z, 0-9/);
    expect(await verifyUser(db, 'adit', 'supersecret')).toMatchObject({ username: 'adit' });
    expect(await verifyUser(db, 'adit', 'wrongpass')).toBeUndefined();
    expect(await verifyUser(db, 'nobody', 'whatever12')).toBeUndefined();
  });

  it('lists users without hashes and refuses to delete the last admin', async () => {
    const admin = await createUser(db, { username: 'adit', password: 'supersecret' });
    await createUser(db, { username: 'bob', password: 'supersecret' });
    const listed = await listUsers(db);
    expect(listed).toHaveLength(2);
    expect(listed[0]).not.toHaveProperty('password_hash');
    expect(await deleteUser(db, admin.id)).toMatchObject({ deleted: false });
    await setUserRole(db, listed[1]!.id, 'admin');
    expect(await deleteUser(db, admin.id)).toMatchObject({ deleted: true });
  });

  it('deleting a user removes their sessions but never the last admin', async () => {
    const admin = await createUser(db, { username: 'adit', password: 'supersecret' });
    const store = new PgSessionStore(db, admin.id);
    await store.write(record('m1'));
    // Last-admin refusal keeps the user (and the session) alive.
    expect(await deleteUser(db, admin.id)).toMatchObject({ deleted: false });
    expect(await store.read('m1')).toBeDefined();
    // A second admin unblocks the delete, and the rows go with the user.
    const backup = await createUser(db, { username: 'bob', password: 'supersecret2' });
    await setUserRole(db, backup.id, 'admin');
    expect(await deleteUser(db, admin.id)).toMatchObject({ deleted: true });
    expect(await store.read('m1')).toBeUndefined();
    expect(await new PgSessionStore(db).list()).toHaveLength(0);
  });

  it('scopes sessions per user; unscoped reads the union', async () => {
    const admin = await createUser(db, { username: 'adit', password: 'supersecret' });
    const bob = await createUser(db, { username: 'bob', password: 'supersecret2', role: 'regular' });
    const forAdmin = new PgSessionStore(db, admin.id);
    const forBob = new PgSessionStore(db, bob.id);
    await forAdmin.write(record('m1', 'Admin session'));
    await forBob.write(record('m1', 'Bob session'));

    expect((await forAdmin.read('m1'))?.title).toBe('Admin session');
    expect((await forBob.read('m1'))?.title).toBe('Bob session');
    expect(await forAdmin.list()).toHaveLength(1);
    await forAdmin.remove('m1');
    expect(await forAdmin.read('m1')).toBeUndefined();
    expect((await forBob.read('m1'))?.title).toBe('Bob session');

    const union = new PgSessionStore(db);
    expect(await union.list()).toHaveLength(1);
  });

  it('keeps the engine token across a tokenless (rename) write', async () => {
    const admin = await createUser(db, { username: 'adit', password: 'supersecret' });
    const store = new PgSessionStore(db, admin.id);
    await store.write(record('m1'), 'token-1');
    await store.write({ ...record('m1'), title: 'Renamed' });
    expect((await store.read('m1'))?.title).toBe('Renamed');
    expect(await store.tokens()).toEqual(new Map([['m1', 'token-1']]));
  });

  it('adopts file sessions into the earliest admin exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morse-adopt-'));
    try {
      const files = new FileSessionStore(join(dir, 'sessions'));
      await files.write(record('m1'), 'token-1');
      await files.write(record('m2'));
      // No users yet: adoption parks rows on the local owner.
      await adoptFileSessions(db, dir, silentLogger);
      expect(await new PgSessionStore(db, LOCAL_OWNER).list()).toHaveLength(2);
      expect(await new PgSessionStore(db, LOCAL_OWNER).tokens()).toEqual(
        new Map([['m1', 'token-1']]),
      );

      const admin = await createUser(db, { username: 'adit', password: 'supersecret' });
      expect(await earliestAdminId(db)).toBe(admin.id);
      await adoptLocalRowsToUser(db, admin.id);
      expect(await new PgSessionStore(db, admin.id).list()).toHaveLength(2);
      expect(await new PgSessionStore(db, LOCAL_OWNER).list()).toHaveLength(0);

      // A second adoption is a no-op even with new file rows.
      await files.write(record('m3'));
      expect(await adoptFileSessions(db, dir, silentLogger)).toBeUndefined();
      expect(await new PgSessionStore(db, admin.id).list()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function record(id: string, title = 'Session'): MorseSessionRecord {
  return {
    version: 2,
    id,
    title,
    cwd: '/repo',
    engineRef: { engine: 'pi', sessionId: `engine-${id}` },
    createdAt: 1000,
    updatedAt: 2000,
    messageCount: 3,
  };
}
