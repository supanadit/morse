import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { removeOsUser, syncOsUser } from '../internal/os-users.js';

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
  name: string;
  email: string;
  role: UserRole;
  /** False while the row still holds the random SSO-provisioned password. */
  passwordSet: boolean;
  createdAt: number;
}

interface UserRow {
  id: string;
  username: string;
  name?: string | null;
  email?: string | null;
  role: string;
  password_set?: string | number | null;
  created_at: string | number;
}

function toUser(row: UserRow): MorseUser {
  return {
    id: row.id,
    username: row.username,
    // Rows written before schema v3 have empty profile fields.
    name: row.name || row.username,
    email: row.email ?? '',
    role: row.role === 'admin' ? 'admin' : 'regular',
    // Rows predate the flag: they were created by a known password.
    passwordSet: row.password_set === undefined || Number(row.password_set) !== 0,
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

function cleanName(value: string | undefined, fallback: string): string {
  const name = (value ?? '').trim();
  if (name.length > 120) {
    throw new Error('A name may be at most 120 characters.');
  }
  return name.length > 0 ? name : fallback;
}

function cleanEmail(value: string | undefined): string {
  const email = (value ?? '').trim();
  if (email.length === 0) {
    return '';
  }
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  return email;
}

function assertPassword(password: string): void {
  if (password.length < 8) {
    throw new Error('A password of at least 8 characters is required.');
  }
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
  options: { username: string; password: string; name?: string; email?: string; role?: UserRole },
): Promise<MorseUser> {
  const username = normalizeUsername(options.username);
  if (username.length === 0) {
    throw new Error('A username is required.');
  }
  // Usernames become workspace directory names (`<root>/<username>`) and, on
  // OS-user hosts, Linux usernames too — so portable characters only, nothing
  // `useradd` refuses (no leading dash, 32 chars max), no dot-dirs. `morse`
  // and `root` are reserved: a login by either name would hand its owner the
  // service account (or worse) instead of a fenced tree.
  if (!/^[a-z0-9._-]+$/.test(username) || username === '.' || username === '..' || /^-/.test(username) || username.length > 32 || username === 'morse' || username === 'root') {
    throw new Error('A username may only contain a-z, 0-9, dot, underscore and dash.');
  }
  assertPassword(options.password);
  const name = cleanName(options.name, username);
  const email = cleanEmail(options.email);
  const existing = await db('morse_users').where({ username }).first();
  if (existing !== undefined) {
    throw new Error(`User "${username}" already exists.`);
  }
  const first = (await countUsers(db)) === 0;
  const user: MorseUser = {
    id: randomUUID(),
    username,
    name,
    email,
    role: first ? 'admin' : (options.role ?? 'regular'),
    passwordSet: true,
    createdAt: Date.now(),
  };
  await db('morse_users').insert({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    password_hash: hashPassword(options.password),
    role: user.role,
    created_at: user.createdAt,
  });
  // Best-effort: the container's SSH login follows the Morse password. A
  // provisioning failure never fails the signup itself.
  syncOsUser(user.username, options.password, (message) => console.warn(message));
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

/** SSO lookup: the user already linked to this provider subject, if any. */
export async function findUserByOidc(
  db: Knex,
  sub: string,
  issuer: string,
): Promise<MorseUser | undefined> {
  const row = await db('morse_users').where({ oidc_sub: sub, oidc_issuer: issuer }).first();
  return row === undefined ? undefined : toUser(row as UserRow);
}

/** Link target for JIT provisioning: the user holding this email, if any. */
export async function findUserByEmail(db: Knex, email: string): Promise<MorseUser | undefined> {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  const row = await db('morse_users').where({ email: normalized }).first();
  return row === undefined ? undefined : toUser(row as UserRow);
}

/** Records the provider link after a successful SSO login. */
export async function setOidcLink(db: Knex, id: string, sub: string, issuer: string): Promise<void> {
  await db('morse_users').where({ id }).update({ oidc_sub: sub, oidc_issuer: issuer });
}

/**
 * First-login provisioning for SSO: creates a regular user (or the first admin
 * when the table is empty, like `createUser`) with an unusable random password
 * — the provider owns the credential, local login stays closed until an admin
 * sets one. Returns undefined when the username is taken by someone else.
 */
export async function createOidcUser(
  db: Knex,
  options: { username: string; name: string; email: string; sub: string; issuer: string },
): Promise<MorseUser | undefined> {
  const existing = await db('morse_users')
    .where({ username: normalizeUsername(options.username) })
    .first();
  if (existing !== undefined) {
    return undefined;
  }
  const first = (await countUsers(db)) === 0;
  const user: MorseUser = {
    id: randomUUID(),
    username: normalizeUsername(options.username),
    name: options.name.slice(0, 120) || options.username,
    email: options.email,
    role: first ? 'admin' : 'regular',
    passwordSet: false,
    createdAt: Date.now(),
  };
  await db('morse_users').insert({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    password_hash: hashPassword(randomUUID() + randomUUID()),
    password_set: 0,
    role: user.role,
    created_at: user.createdAt,
    oidc_sub: options.sub,
    oidc_issuer: options.issuer,
  });
  return user;
}

/** Every user, newest last, without password hashes. */
export async function listUsers(db: Knex): Promise<MorseUser[]> {
  const rows = await db('morse_users')
    .select('id', 'username', 'name', 'email', 'role', 'password_set', 'created_at')
    .orderBy('created_at', 'asc');
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
 * Edits a user's profile, role and/or password. Only supplied fields change;
 * an empty patch is a no-op that still reports whether the user exists.
 */
export async function updateUser(
  db: Knex,
  id: string,
  patch: { name?: string; email?: string; role?: UserRole; password?: string },
): Promise<MorseUser | undefined> {
  const existing = await findUserById(db, id);
  if (existing === undefined) {
    return undefined;
  }
  const changes: Record<string, string | number> = {};
  if (patch.name !== undefined) {
    changes.name = cleanName(patch.name, existing.username);
  }
  if (patch.email !== undefined) {
    changes.email = cleanEmail(patch.email);
  }
  if (patch.role !== undefined) {
    changes.role = patch.role;
  }
  if (patch.password !== undefined) {
    assertPassword(patch.password);
    changes.password_hash = hashPassword(patch.password);
    // A real password now exists: SSH and local login unlock together.
    changes.password_set = 1;
  }
  if (Object.keys(changes).length > 0) {
    await db('morse_users').where({ id }).update(changes);
  }
  if (patch.password !== undefined) {
    syncOsUser(existing.username, patch.password, (message) => console.warn(message));
  }
  return findUserById(db, id);
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
  // The home directory (their data) stays; only the login goes.
  removeOsUser(target.username, (message) => console.warn(message));
  return { deleted: true };
}
