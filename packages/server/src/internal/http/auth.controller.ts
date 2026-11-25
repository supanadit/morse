import { Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { Knex } from 'knex';
import type { AuthUser } from '@morse/protocol';
import type { MorseLogger } from '@morse/system';
import type { MorseServerConfig } from '../../app/config.js';
import { MORSE_CONFIG, MORSE_DB, MORSE_LOGGER } from '../../app/tokens.js';
import { adoptLocalRowsToUser } from '../../db/factory.js';
import { createToken, resolveToken, revokeToken } from '../../db/tokens.js';
import { countUsers, createUser, verifyUser } from '../../db/users.js';

/**
 * Login for multi-user Morse (`morse config set multiuser true`). Single-user
 * hosts never mount these routes' logic — every handler refuses when the flag
 * is off — and keep their Basic-auth gate instead.
 *
 * Identity travels in the `morse_token` cookie (httpOnly, host-only): browsers
 * replay it on the WebSocket upgrade with no frontend change, and the gateway
 * resolves it to the connection's user. Only the sha256 of each token is
 * stored; logout deletes the row.
 */

export const AUTH_COOKIE = 'morse_token';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** The slice of the HTTP req/res this controller touches (Express at runtime). */
interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface AuthResponse {
  setHeader(name: string, value: string | string[]): unknown;
}

function refuse(status: number, message: string): HttpException {
  const exception = new HttpException({ error: message }, status);
  exception.message = message;
  return exception;
}

function cookieOf(request: AuthRequest, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

function setAuthCookie(response: AuthResponse, token: string): void {
  response.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`,
  );
}

function clearAuthCookie(response: AuthResponse): void {
  response.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(MORSE_CONFIG) private readonly config: MorseServerConfig,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
    @Inject(MORSE_DB) private readonly db: Knex | undefined,
  ) {}

  private requireDb(): Knex {
    if (!this.config.multiuser || this.db === undefined) {
      throw refuse(HttpStatus.NOT_FOUND, 'This host is not in multi-user mode.');
    }
    return this.db;
  }

  /** What the login page needs before it renders: mode, setup state, and — with a valid cookie — who is already in. */
  @Get('status')
  async status(@Req() rawRequest: unknown): Promise<{
    multiuser: boolean;
    setupRequired: boolean;
    user?: AuthUser;
  }> {
    if (!this.config.multiuser || this.db === undefined) {
      return { multiuser: false, setupRequired: false };
    }
    const request = rawRequest as AuthRequest;
    const setupRequired = (await countUsers(this.db)) === 0;
    const token = cookieOf(request, AUTH_COOKIE);
    const user = token === undefined ? undefined : await resolveToken(this.db, token);
    return {
      multiuser: true,
      setupRequired,
      ...(user === undefined ? {} : { user }),
    };
  }

  /**
   * Creates the first (admin) user. Only while no user exists at all — the
   * first-run wizard's single shot. Later admins are made by an admin, through
   * `adminCreateUser`, never here.
   */
  @Post('setup')
  async setup(
    @Body() body: { username?: unknown; password?: unknown },
    @Res({ passthrough: true }) rawResponse: unknown,
  ): Promise<{ user: AuthUser }> {
    const response = rawResponse as AuthResponse;
    const db = this.requireDb();
    if ((await countUsers(db)) > 0) {
      throw refuse(HttpStatus.FORBIDDEN, 'Setup is already complete. Ask an admin to create your account.');
    }
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    try {
      const created = await createUser(db, { username, password });
      // Sessions adopted (and written) before anyone existed belong to them.
      await adoptLocalRowsToUser(db, created.id);
      const token = await createToken(db, created.id);
      setAuthCookie(response, token);
      this.logger.info(`First admin "${created.username}" created; multi-user setup complete.`);
      return { user: { id: created.id, username: created.username, role: created.role } };
    } catch (error: unknown) {
      throw refuse(HttpStatus.BAD_REQUEST, error instanceof Error ? error.message : 'Setup failed.');
    }
  }

  /** Login: verifies the password and mints a cookie token. */
  @Post('login')
  async login(
    @Body() body: { username?: unknown; password?: unknown },
    @Res({ passthrough: true }) rawResponse: unknown,
  ): Promise<{ user: AuthUser }> {
    const response = rawResponse as AuthResponse;
    const db = this.requireDb();
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = await verifyUser(db, username, password);
    // A beat against credential stuffing: every miss costs the same second.
    if (user === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw refuse(HttpStatus.UNAUTHORIZED, 'Wrong username or password.');
    }
    const token = await createToken(db, user.id);
    setAuthCookie(response, token);
    return { user: { id: user.id, username: user.username, role: user.role } };
  }

  /** Logout: revokes the cookie's token and clears it. */
  @Post('logout')
  async logout(
    @Req() rawRequest: unknown,
    @Res({ passthrough: true }) rawResponse: unknown,
  ): Promise<{ ok: true }> {
    const request = rawRequest as AuthRequest;
    const response = rawResponse as AuthResponse;
    const db = this.requireDb();
    const token = cookieOf(request, AUTH_COOKIE);
    if (token !== undefined) {
      await revokeToken(db, token);
    }
    clearAuthCookie(response);
    return { ok: true };
  }
}

/** Resolves the login cookie of an HTTP or WebSocket upgrade request. */
export async function authUserOfRequest(
  db: Knex | undefined,
  headers: Record<string, unknown>,
): Promise<AuthUser | undefined> {
  if (db === undefined) {
    return undefined;
  }
  const header = String(headers.cookie ?? headers.Cookie ?? '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === AUTH_COOKIE) {
      return resolveToken(db, decodeURIComponent(part.slice(index + 1).trim()));
    }
  }
  return undefined;
}
