import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';

/**
 * The `morse_users` table: login identity and role for multi-user Morse.
 *
 * Passwords are scrypt hashes (`scrypt$salt$hash`, stdlib only — no new
 * dependency). The hash never leaves this module: listings project it away.
 */

export type UserRole = 'admin' | 'regular';

export interface MorseUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: number;
}

interface UserRow {
  id: string;
  username: string;
  role: string;
  created_at: string | number;
}

function toUser(row: UserRow): MorseUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'regular',
    createdAt: Number(row.created_at),
  };
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || parts[1] === undefined || parts[2] === undefined) {
    return false;
  }
  const candidate = scryptSync(password, parts[1], 64);
  const expected = Buffer.from(parts[2], 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** How many login identities exist — `0` means the first-run wizard is due. */
export async function countUsers(db: Knex): Promise<number> {
  const row = await db('morse_users').count({ count: '*' }).first();
  return Number(row?.count ?? 0);
}

/**
 * Creates a user. The first user ever created is always `admin` (the wizard
 * path), whatever role was asked for — an empty table must never produce a
 * host with no administrator.
 */
export async function createUser(
  db: Knex,
  options: { username: string; password: string; role?: UserRole },
): Promise<MorseUser> {
  const username = normalizeUsername(options.username);
  if (username.length === 0) {
    throw new Error('A username is required.');
  }
  // Usernames become workspace directory names (`<root>/<username>`), so only
  // portable characters are allowed — no slashes, no dot-dirs, no surprises.
  if (!/^[a-z0-9._-]+$/.test(username)) {
    throw new Error('A username may only contain a-z, 0-9, dot, underscore and dash.');
  }
  if (options.password.length < 8) {
    throw new Error('A password of at least 8 characters is required.');
  }
  const existing = await db('morse_users').where({ username }).first();
  if (existing !== undefined) {
    throw new Error(`User "${username}" already exists.`);
  }
  const first = (await countUsers(db)) === 0;
  const user: MorseUser = {
    id: randomUUID(),
    username,
    role: first ? 'admin' : (options.role ?? 'regular'),
    createdAt: Date.now(),
  };
  await db('morse_users').insert({
    id: user.id,
    username: user.username,
    password_hash: hashPassword(options.password),
    role: user.role,
    created_at: user.createdAt,
  });
  return user;
}

/** The login check: undefined when the username is unknown or the password misses. */
export async function verifyUser(
  db: Knex,
  username: string,
  password: string,
): Promise<MorseUser | undefined> {
  const row = await db('morse_users').where({ username: normalizeUsername(username) }).first();
  if (row === undefined) {
    return undefined;
  }
  const stored = (row as { password_hash: string }).password_hash;
  if (!verifyPassword(password, stored)) {
    return undefined;
  }
  return toUser(row as UserRow);
}

export async function findUserById(db: Knex, id: string): Promise<MorseUser | undefined> {
  const row = await db('morse_users').where({ id }).first();
  return row === undefined ? undefined : toUser(row as UserRow);
}

/** Every user, newest last, without password hashes. */
export async function listUsers(db: Knex): Promise<MorseUser[]> {
  const rows = await db('morse_users').select('id', 'username', 'role', 'created_at').orderBy('created_at', 'asc');
  return (rows as UserRow[]).map(toUser);
}

/** The earliest admin — the owner old file sessions are adopted into. */
export async function earliestAdminId(db: Knex): Promise<string | undefined> {
  const row = await db('morse_users')
    .select('id')
    .where({ role: 'admin' })
    .orderBy('created_at', 'asc')
    .first();
  if (row !== undefined) {
    return (row as { id: string }).id;
  }
  const fallback = await db('morse_users').select('id').orderBy('created_at', 'asc').first();
  return fallback === undefined ? undefined : (fallback as { id: string }).id;
}

export async function setUserRole(db: Knex, id: string, role: UserRole): Promise<boolean> {
  const changed = await db('morse_users').where({ id }).update({ role });
  return changed > 0;
}

/**
 * Deletes a user and every session row they own (explicitly — `user_id` is
 * owner metadata, not a foreign key, so the cascade lives here). Refuses the
 * last admin: a host with users but no administrator cannot be managed back.
 * Returns false when the user is unknown.
 */
export async function deleteUser(db: Knex, id: string): Promise<{ deleted: boolean; reason?: string }> {
  const target = await findUserById(db, id);
  if (target === undefined) {
    return { deleted: false };
  }
  if (target.role === 'admin') {
    const admins = await db('morse_users').where({ role: 'admin' }).count({ count: '*' }).first();
    if (Number(admins?.count ?? 0) <= 1) {
      return { deleted: false, reason: 'Cannot delete the last admin.' };
    }
  }
  await db('morse_sessions').where({ user_id: id }).delete();
  await db('morse_users').where({ id }).delete();
  return { deleted: true };
}
