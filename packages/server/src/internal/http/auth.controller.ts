import { Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Knex } from 'knex';
import type { AuthUser } from '@morse/protocol';
import type { MorseLogger } from '@morse/system';
import type { MorseServerConfig } from '../../app/config.js';
import { MORSE_CONFIG, MORSE_DB, MORSE_LOGGER } from '../../app/tokens.js';
import { adoptLocalRowsToUser } from '../../db/factory.js';
import { effectiveOidc, isOidcUsable, loadOidcConfig, saveOidcConfig, type StoredOidcConfig } from '../../db/oidc-config.js';
import { createToken, isOidcSession, resolveToken, revokeToken, revokeUserTokens } from '../../db/tokens.js';
import {
  countUsers,
  createOidcUser,
  createUser,
  findUserByEmail,
  findUserById,
  findUserByOidc,
  setOidcLink,
  updateUser,
  verifyUser,
} from '../../db/users.js';
import {
  buildLoginUrl,
  discoverEndpoints,
  exchangeCode,
  fetchUserinfo,
  normalizeProfile,
  OidcLoginStore,
  resolveEndpoints,
} from '../auth/oidc.js';

/**
 * Login for multi-user Morse (`morse config set multiuser true`). Single-user
 * hosts never mount these routes' logic — every handler refuses when the flag
 * is off — and keep their Basic-auth gate instead.
 *
 * Identity travels in the `morse_token` cookie (httpOnly, host-only): browsers
 * replay it on the WebSocket upgrade with no frontend change, and the gateway
 * resolves it to the connection's user. Only the sha256 of each token is
 * stored; logout deletes the row.
 *
 * SSO is an optional second door on the same house: one generic OIDC/OAuth2
 * provider (env-managed via `MORSE_OIDC_*`, or saved by an admin on the
 * settings page). Local login keeps working either way, and every SSO account
 * links to the same `morse_users` row — by provider subject first, by email
 * otherwise — so enabling SSO never strands an existing member.
 */

export const AUTH_COOKIE = 'morse_token';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** The slice of the HTTP req/res this controller touches (Express at runtime). */
interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  get?: (name: string) => string | undefined;
}
interface AuthResponse {
  setHeader(name: string, value: string | string[]): unknown;
  redirect?(url: string): unknown;
  status?(code: number): { send(body: string): unknown };
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

function authCookieHeader(token: string): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
}

function setAuthCookie(response: AuthResponse, token: string): void {
  response.setHeader('Set-Cookie', authCookieHeader(token));
}

function clearAuthCookie(response: AuthResponse): void {
  response.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function toAuthUser(user: { id: string; username: string; role: 'admin' | 'regular'; name: string; email: string }): AuthUser {
  return { id: user.id, username: user.username, role: user.role, name: user.name, email: user.email };
}

@Controller('api/auth')
export class AuthController {
  /** One pending login per redirect: in-memory, this process only. */
  private readonly logins = new OidcLoginStore();

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

  private async requireAdmin(rawRequest: unknown): Promise<{ db: Knex; user: AuthUser }> {
    const db = this.requireDb();
    const user = await authUserOfRequest(db, (rawRequest as AuthRequest).headers as Record<string, unknown>);
    if (user === undefined) {
      throw refuse(HttpStatus.UNAUTHORIZED, 'Login required.');
    }
    if (user.role !== 'admin') {
      throw refuse(HttpStatus.FORBIDDEN, 'An admin account is required.');
    }
    return { db, user };
  }

  /** True when the provider is on, usable, and the only door: no password login. */
  private async ssoOnly(): Promise<boolean> {
    const provider = await this.oidcProvider();
    return (
      provider !== undefined && provider.enabled && isOidcUsable(provider) && !provider.allowPassword
    );
  }

  /** The effective SSO provider: env when env-managed, else the admin page's row. */
  private async oidcProvider(): Promise<
    (StoredOidcConfig & { managedByEnv: boolean }) | undefined
  > {
    if (this.db === undefined) {
      return this.config.oidcManagedByEnv
        ? { ...this.config.oidc, managedByEnv: true }
        : undefined;
    }
    const stored = await loadOidcConfig(this.db).catch(() => undefined);
    return effectiveOidc(this.config.oidc, this.config.oidcManagedByEnv, stored);
  }

  private baseUrl(request: AuthRequest): string {
    // Behind a proxy the host sees http while the browser used https: prefer
    // the forwarded proto/host the deployment already sets for this purpose.
    const forwardedProto =
      request.headers['x-forwarded-proto'] ??
      (typeof request.get === 'function' ? request.get('x-forwarded-proto') : undefined);
    const proto =
      (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ??
      request.protocol ??
      'http';
    const forwardedHost =
      request.headers['x-forwarded-host'] ??
      (typeof request.get === 'function' ? request.get('x-forwarded-host') : undefined);
    const host =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
      request.headers.host ??
      `${this.config.host}:${this.config.port}`;
    return `${String(proto).split(',')[0]?.trim()}://${String(host).split(',')[0]?.trim()}`;
  }

  private callbackUrl(request: AuthRequest): string {
    return `${this.baseUrl(request)}/api/auth/oidc/callback`;
  }

  /** What the login page needs before it renders: mode, setup state, SSO door, and — with a valid cookie — who is already in. */
  @Get('status')
  async status(@Req() rawRequest: unknown): Promise<{
    multiuser: boolean;
    setupRequired: boolean;
    user?: AuthUser;
    oidc?: { enabled: boolean; displayName: string; allowPassword: boolean };
  }> {
    if (!this.config.multiuser || this.db === undefined) {
      return { multiuser: false, setupRequired: false };
    }
    const request = rawRequest as AuthRequest;
    const setupRequired = (await countUsers(this.db)) === 0;
    const token = cookieOf(request, AUTH_COOKIE);
    const user = token === undefined ? undefined : await resolveToken(this.db, token);
    const provider = await this.oidcProvider();
    const oidc =
      provider !== undefined && provider.enabled && isOidcUsable(provider)
        ? { enabled: true as const, displayName: provider.displayName, allowPassword: provider.allowPassword }
        : undefined;
    return {
      multiuser: true,
      setupRequired,
      ...(user === undefined ? {} : { user }),
      ...(oidc === undefined ? {} : { oidc }),
    };
  }

  /**
   * Creates the first (admin) user. Only while no user exists at all — the
   * first-run wizard's single shot. Refused under SSO-only: the first admin
   * arrives through the provider instead (first login provisions as admin).
   */
  @Post('setup')
  async setup(
    @Body() body: { username?: unknown; password?: unknown; name?: unknown; email?: unknown },
    @Res({ passthrough: true }) rawResponse: unknown,
  ): Promise<{ user: AuthUser }> {
    const response = rawResponse as AuthResponse;
    const db = this.requireDb();
    if ((await countUsers(db)) > 0) {
      throw refuse(HttpStatus.FORBIDDEN, 'Setup is already complete. Ask an admin to create your account.');
    }
    if (await this.ssoOnly()) {
      throw refuse(HttpStatus.FORBIDDEN, 'Password setup is off: sign in with single sign-on instead.');
    }
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' ? body.name : undefined;
    const email = typeof body.email === 'string' ? body.email : undefined;
    try {
      const created = await createUser(db, { username, password, name, email });
      // Sessions adopted (and written) before anyone existed belong to them.
      await adoptLocalRowsToUser(db, created.id);
      const token = await createToken(db, created.id);
      setAuthCookie(response, token);
      this.logger.info(`First admin "${created.username}" created; multi-user setup complete.`);
      return { user: toAuthUser(created) };
    } catch (error: unknown) {
      throw refuse(HttpStatus.BAD_REQUEST, error instanceof Error ? error.message : 'Setup failed.');
    }
  }

  /** Login: verifies the password and mints a cookie token (refused under SSO-only). */
  @Post('login')
  async login(
    @Body() body: { username?: unknown; password?: unknown },
    @Res({ passthrough: true }) rawResponse: unknown,
  ): Promise<{ user: AuthUser }> {
    const response = rawResponse as AuthResponse;
    const db = this.requireDb();
    if (await this.ssoOnly()) {
      throw refuse(HttpStatus.FORBIDDEN, 'Password login is off: use single sign-on instead.');
    }
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
    return { user: toAuthUser(user) };
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

  /** Starts the SSO login: redirects the browser to the provider. */
  @Get('oidc/login')
  async oidcLogin(@Req() rawRequest: unknown, @Res() rawResponse: unknown): Promise<void> {
    this.requireDb();
    const provider = await this.oidcProvider();
    if (provider === undefined || !provider.enabled || !isOidcUsable(provider)) {
      throw refuse(HttpStatus.NOT_FOUND, 'Single sign-on is not configured on this host.');
    }
    let endpoints: { authUrl: string; tokenUrl: string; userinfoUrl: string };
    try {
      endpoints = await resolveEndpoints(provider);
    } catch (error: unknown) {
      throw refuse(HttpStatus.BAD_GATEWAY, error instanceof Error ? error.message : 'Could not reach the provider.');
    }
    const request = rawRequest as AuthRequest;
    const redirectUri = this.callbackUrl(request);
    const { state, verifier } = this.logins.create();
    const response = rawResponse as AuthResponse;
    response.setHeader(
      'Set-Cookie',
      `morse_oidc=${encodeURIComponent(state)}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    response.redirect?.(buildLoginUrl(provider, endpoints, redirectUri, state, verifier));
  }

  /** Provider callback: exchanges the code, links or provisions the user, sets the login cookie. */
  @Get('oidc/callback')
  async oidcCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() rawRequest: unknown,
    @Res() rawResponse: unknown,
  ): Promise<void> {
    const db = this.requireDb();
    const response = rawResponse as AuthResponse & { redirect(url: string): unknown };
    const fail = (message: string): void => {
      // No JSON here: the browser is mid-redirect, so the failure has to read
      // as a page rather than an API error. Keep it one line, no internals.
      response.status?.(403).send(`<pre>Single sign-on failed: ${escapeHtml(message)}</pre>`);
    };
    if (typeof code !== 'string' || code.length === 0 || typeof state !== 'string' || state.length === 0) {
      fail('The provider returned no login to finish.');
      return;
    }
    const pending = this.logins.take(state);
    if (pending === undefined) {
      fail('This login expired or was already used. Start again from the login page.');
      return;
    }
    const provider = await this.oidcProvider();
    if (provider === undefined || !provider.enabled || !isOidcUsable(provider)) {
      fail('Single sign-on is not configured on this host.');
      return;
    }
    try {
      const endpoints = await resolveEndpoints(provider);
      const request = rawRequest as AuthRequest;
      const tokens = await exchangeCode(provider, endpoints.tokenUrl, code, this.callbackUrl(request), pending.verifier);
      const userinfo = await fetchUserinfo(endpoints.userinfoUrl, tokens.access_token ?? '');
      const profile = normalizeProfile(userinfo, tokens.id_token, endpoints.userinfoUrl);
      let user = await findUserByOidc(db, profile.sub, profile.issuer);
      if (user === undefined && profile.email.length > 0) {
        user = await findUserByEmail(db, profile.email);
        if (user !== undefined) {
          // Same person, new door: link the provider so next time is direct.
          await setOidcLink(db, user.id, profile.sub, profile.issuer);
        }
      }
      if (user === undefined) {
        if (!provider.allowSignup) {
          fail('No account exists for this login. Ask an admin to create one first.');
          return;
        }
        const created = await createOidcUser(db, {
          username: profile.username,
          name: profile.name,
          email: profile.email,
          sub: profile.sub,
          issuer: profile.issuer,
        });
        if (created === undefined) {
          fail('The provider username is already taken by another member.');
          return;
        }
        await adoptLocalRowsToUser(db, created.id).catch(() => undefined);
        user = created;
        this.logger.info(`SSO user "${created.username}" provisioned via ${provider.displayName}.`);
      }
      const token = await createToken(db, user.id, true);
      // One header write: Express's setHeader replaces, so setting the login
      // cookie and clearing the helper cookie must ride one Set-Cookie.
      response.setHeader('Set-Cookie', [
        authCookieHeader(token),
        'morse_oidc=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0',
      ]);
      response.redirect('/');
    } catch (error: unknown) {
      this.logger.warn(`SSO login failed: ${error instanceof Error ? error.message : String(error)}`);
      fail(error instanceof Error ? error.message : 'Login failed.');
    }
  }

  /**
   * Logout that also ends the provider session: revokes the local token, then
   * bounces the browser through the provider's end-session endpoint (which is
   * what lets the next login pick a different user). Password logins, unknown
   * sessions and providers without a logout endpoint end locally instead.
   */
  @Get('oidc/logout')
  async oidcLogout(@Req() rawRequest: unknown, @Res() rawResponse: unknown): Promise<void> {
    const db = this.requireDb();
    const request = rawRequest as AuthRequest;
    const response = rawResponse as AuthResponse & { redirect(url: string): unknown };
    const token = cookieOf(request, AUTH_COOKIE);
    const viaOidc = token === undefined ? false : await isOidcSession(db, token);
    if (token !== undefined) {
      await revokeToken(db, token);
    }
    clearAuthCookie(response);
    if (viaOidc) {
      const provider = await this.oidcProvider();
      if (provider !== undefined && provider.enabled && isOidcUsable(provider)) {
        try {
          const endpoints = await resolveEndpoints(provider);
          if (endpoints.endSessionUrl !== undefined) {
            const url = new URL(endpoints.endSessionUrl);
            url.searchParams.set('post_logout_redirect_uri', `${this.baseUrl(request)}/`);
            if (provider.clientId !== undefined) {
              url.searchParams.set('client_id', provider.clientId);
            }
            response.redirect(url.toString());
            return;
          }
        } catch {
          this.logger.warn('SSO logout could not reach the provider; ending the local session only.');
        }
      }
    }
    response.redirect('/');
  }

  /**
   * Self-service password: what the Access → Password page needs — whether
   * this member must prove the current password first. SSO-provisioned rows
   * (random password nobody knows) skip that; everyone else does not.
   */
  @Get('password')
  async passwordStatus(@Req() rawRequest: unknown): Promise<{ needsCurrent: boolean }> {
    const db = this.requireDb();
    const user = await authUserOfRequest(db, (rawRequest as AuthRequest).headers as Record<string, unknown>);
    if (user === undefined) {
      throw refuse(HttpStatus.UNAUTHORIZED, 'Login required.');
    }
    const full = await findUserById(db, user.id);
    return { needsCurrent: full?.passwordSet !== false };
  }

  /**
   * Sets the caller's own password — the same credential SSH and local login
   * read. With a known password the current one must verify first; without
   * one (SSO-provisioned) it is set directly. Either way every session of
   * that user ends here, exactly like the admin edit, so the reader re-proves
   * the new credential on the next screen.
   */
  @Post('password')
  async changePassword(
    @Req() rawRequest: unknown,
    @Body() body: { currentPassword?: unknown; newPassword?: unknown },
  ): Promise<{ ok: true }> {
    const db = this.requireDb();
    const request = rawRequest as AuthRequest;
    const user = await authUserOfRequest(db, request.headers as Record<string, unknown>);
    if (user === undefined) {
      throw refuse(HttpStatus.UNAUTHORIZED, 'Login required.');
    }
    const full = await findUserById(db, user.id);
    if (full === undefined) {
      throw refuse(HttpStatus.UNAUTHORIZED, 'Login required.');
    }
    if (full.passwordSet !== false) {
      const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const verified = await verifyUser(db, full.username, current);
      if (verified === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        throw refuse(HttpStatus.UNAUTHORIZED, 'The current password is wrong.');
      }
    }
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    try {
      // The write also flips the flag and syncs the OS user for SSH hosts.
      const updated = await updateUser(db, user.id, { password: next });
      if (updated === undefined) {
        throw new Error('No such user.');
      }
    } catch (error: unknown) {
      throw refuse(HttpStatus.BAD_REQUEST, error instanceof Error ? error.message : 'Could not set the password.');
    }
    await revokeUserTokens(db, user.id);
    this.logger.info(`User "${full.username}" set their own password.`);
    return { ok: true };
  }

  /** Admin read: the saved SSO provider, or the env one (read-only) when managed there. */
  @Get('oidc/config')
  async oidcConfig(@Req() rawRequest: unknown): Promise<{
    managedByEnv: boolean;
    config: StoredOidcConfig & { hasSecret: boolean };
  }> {
    await this.requireAdmin(rawRequest);
    const managedByEnv = this.config.oidcManagedByEnv;
    const provider = await this.oidcProvider();
    const fallback: StoredOidcConfig = {
      enabled: false,
      displayName: 'Single sign-on',
      scopes: 'openid profile email',
      allowSignup: true,
      allowPassword: true,
    };
    const config = provider ?? fallback;
    return {
      managedByEnv,
      config: { ...config, clientSecret: undefined, hasSecret: (config.clientSecret?.length ?? 0) > 0 },
    };
  }

  /** Admin write: replaces the saved SSO provider (refused when env-managed). */
  @Post('oidc/config')
  async oidcSave(
    @Req() rawRequest: unknown,
    @Body()
    body: {
      enabled?: unknown;
      displayName?: unknown;
      discoveryUrl?: unknown;
      authUrl?: unknown;
      tokenUrl?: unknown;
      userinfoUrl?: unknown;
      endSessionUrl?: unknown;
      clientId?: unknown;
      clientSecret?: unknown;
      scopes?: unknown;
      allowSignup?: unknown;
      allowPassword?: unknown;
    },
  ): Promise<{ ok: true }> {
    const { db } = await this.requireAdmin(rawRequest);
    if (this.config.oidcManagedByEnv) {
      throw refuse(HttpStatus.FORBIDDEN, 'Single sign-on is managed by the environment; unset MORSE_OIDC_* to edit it here.');
    }
    const textOf = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    const enabled = body.enabled === true;
    const allowSignup = body.allowSignup !== false;
    const allowPassword = body.allowPassword !== false;
    // Note: SSO-only without sign-up is only closable while users exist —
    // and saving needs an admin login, so that holds by construction. A fresh
    // host always keeps its first entry: SSO sign-up, or the local setup.
    await saveOidcConfig(db, {
      enabled,
      displayName: textOf(body.displayName) ?? 'Single sign-on',
      discoveryUrl: textOf(body.discoveryUrl),
      authUrl: textOf(body.authUrl),
      tokenUrl: textOf(body.tokenUrl),
      userinfoUrl: textOf(body.userinfoUrl),
      endSessionUrl: textOf(body.endSessionUrl),
      clientId: textOf(body.clientId),
      clientSecret: typeof body.clientSecret === 'string' ? body.clientSecret : undefined,
      scopes: textOf(body.scopes) ?? 'openid profile email',
      allowSignup,
      allowPassword,
    });
    this.logger.info('SSO provider configuration updated by an admin.');
    return { ok: true };
  }

  /** Admin probe: fills the endpoint fields from a discovery URL (refused when env-managed). */
  @Post('oidc/discover')
  async oidcDiscover(
    @Req() rawRequest: unknown,
    @Body() body: { discoveryUrl?: unknown },
  ): Promise<{ authUrl: string; tokenUrl: string; userinfoUrl: string; endSessionUrl?: string }> {
    await this.requireAdmin(rawRequest);
    if (this.config.oidcManagedByEnv) {
      throw refuse(HttpStatus.FORBIDDEN, 'Single sign-on is managed by the environment; unset MORSE_OIDC_* to edit it here.');
    }
    const discoveryUrl = typeof body.discoveryUrl === 'string' ? body.discoveryUrl.trim() : '';
    if (discoveryUrl.length === 0) {
      throw refuse(HttpStatus.BAD_REQUEST, 'Enter a discovery URL first.');
    }
    try {
      return await discoverEndpoints(discoveryUrl);
    } catch (error: unknown) {
      throw refuse(HttpStatus.BAD_GATEWAY, error instanceof Error ? error.message : 'Discovery failed.');
    }
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
