import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import type { AuthUser } from '@morse/protocol';
import { findUserById } from './users.js';

/**
 * Login sessions for multi-user Morse: one opaque bearer per login, carried in
 * the `morse_token` cookie (and so replayed on the WebSocket upgrade).
 *
 * Only the sha256 of the token is stored — a database read never yields a live
 * session — and every token expires (30 days). Logout deletes the row.
 */

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mints a login session for a user. Returns the raw token for the cookie. */
export async function createToken(db: Knex, userId: string, viaOidc = false): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  await db('morse_tokens').insert({
    token_hash: hashToken(token),
    user_id: userId,
    created_at: now,
    expires_at: now + TOKEN_TTL_MS,
    oidc: viaOidc ? 1 : 0,
  });
  return token;
}

/**
 * Resolves a presented token to its user. Expired rows are deleted on sight,
 * so the table cannot fill with dead sessions.
 */
export async function resolveToken(db: Knex, token: string): Promise<AuthUser | undefined> {
  const row = await db('morse_tokens').where({ token_hash: hashToken(token) }).first();
  if (row === undefined) {
    return undefined;
  }
  const entry = row as { user_id: string; expires_at: string | number };
  if (Number(entry.expires_at) <= Date.now()) {
    await db('morse_tokens').where({ token_hash: hashToken(token) }).delete();
    return undefined;
  }
  const user = await findUserById(db, entry.user_id);
  return user === undefined
    ? undefined
    : {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name,
        email: user.email,
      };
}

/** True when this login session came through SSO (its logout bounces via the provider). Unknown or expired tokens read as local logins. */
export async function isOidcSession(db: Knex, token: string): Promise<boolean> {
  try {
    const row = await db('morse_tokens').where({ token_hash: hashToken(token) }).first();
    if (row === undefined) {
      return false;
    }
    return Number((row as { oidc?: string | number }).oidc ?? 0) === 1;
  } catch {
    // A host whose schema predates the flag: plain logout, never a crash.
    return false;
  }
}

/** Ends one login session. True when a row was actually revoked. */
export async function revokeToken(db: Knex, token: string): Promise<boolean> {
  const deleted = await db('morse_tokens').where({ token_hash: hashToken(token) }).delete();
  return deleted > 0;
}

/** Ends every login session of a user (password change, admin delete). */
export async function revokeUserTokens(db: Knex, userId: string): Promise<void> {
  await db('morse_tokens').where({ user_id: userId }).delete();
}
