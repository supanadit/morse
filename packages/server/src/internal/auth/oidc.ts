import { createHash, randomBytes } from 'node:crypto';
import type { StoredOidcConfig } from '../../db/oidc-config.js';

/**
 * Generic OIDC / OAuth2 Authorization Code flow with PKCE (S256), stdlib only.
 *
 * Identity comes from the provider's userinfo endpoint (the access token's
 * answer), not from the id_token's claims — so no JWKS verification is needed
 * and any OAuth2 provider with a userinfo-compatible endpoint works. The
 * id_token is decoded only for its subject as a fallback link.
 */

export interface OidcProfile {
  /** Stable provider subject (userinfo `sub`, else the id_token's). */
  sub: string;
  /** Issuer for the link (`iss` claim, else the userinfo URL). */
  issuer: string;
  email: string;
  name: string;
  username: string;
}

interface PendingLogin {
  state: string;
  verifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

/** In-memory login attempts: one entry per redirect, gone after the callback. */
export class OidcLoginStore {
  private readonly pending = new Map<string, PendingLogin>();

  create(): { state: string; verifier: string } {
    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    this.sweep();
    this.pending.set(state, { state, verifier, createdAt: Date.now() });
    return { state, verifier };
  }

  take(state: string): PendingLogin | undefined {
    const found = this.pending.get(state);
    if (found !== undefined) {
      this.pending.delete(state);
    }
    if (found !== undefined && Date.now() - found.createdAt > PENDING_TTL_MS) {
      return undefined;
    }
    return found;
  }

  private sweep(): void {
    if (this.pending.size < 100) {
      return;
    }
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, value] of this.pending) {
      if (value.createdAt < cutoff) {
        this.pending.delete(key);
      }
    }
  }
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** The URL the browser visits to start the provider's login. */
export function buildLoginUrl(
  config: StoredOidcConfig,
  endpoints: { authUrl: string },
  redirectUri: string,
  state: string,
  verifier: string,
): string {
  const url = new URL(endpoints.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId ?? '');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
}

/** Exchanges the callback code for tokens (throws with the provider's words). */
export async function exchangeCode(
  config: StoredOidcConfig,
  tokenUrl: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  body.set('client_id', config.clientId ?? '');
  if (config.clientSecret !== undefined && config.clientSecret.length > 0) {
    body.set('client_secret', config.clientSecret);
  }
  body.set('code_verifier', verifier);
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | (TokenResponse & { error?: string; error_description?: string })
    | undefined;
  if (!response.ok || payload?.access_token === undefined) {
    throw new Error(
      payload?.error_description ?? payload?.error ?? `Token exchange failed (${response.status}).`,
    );
  }
  return payload;
}

/** Reads the profile behind the access token (throws with the provider's words). */
export async function fetchUserinfo(userinfoUrl: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(userinfoUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const payload = (await response.json().catch(() => undefined)) as
    | (Record<string, unknown> & { error?: string; error_description?: string })
    | undefined;
  if (!response.ok || payload === undefined) {
    throw new Error(
      payload?.error_description ?? payload?.error ?? `Userinfo request failed (${response.status}).`,
    );
  }
  return payload;
}

/** Base64url-decodes one JWT segment without verifying (subject fallback only). */
function decodeJwtSegment(token: string, index: number): Record<string, unknown> | undefined {
  try {
    const segment = token.split('.')[index];
    if (segment === undefined) {
      return undefined;
    }
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Normalizes a userinfo answer (+ id_token fallback) into the link + profile.
 * Throws when neither yields a subject or no email address is present — without
 * an email there is nothing to match a local user against or provision from.
 */
export function normalizeProfile(
  userinfo: Record<string, unknown>,
  idToken: string | undefined,
  fallbackIssuer: string,
): OidcProfile {
  const claims = idToken === undefined ? undefined : decodeJwtSegment(idToken, 1);
  const sub = text(userinfo['sub']) || text(claims === undefined ? undefined : claims['sub']);
  if (sub.length === 0) {
    throw new Error('The provider returned no user id (sub).');
  }
  const email = text(userinfo['email']).toLowerCase();
  if (email.length === 0 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('The provider returned no email address for this account.');
  }
  const issuer = text(claims === undefined ? undefined : claims['iss']) || fallbackIssuer;
  const name =
    text(userinfo['name']) ||
    [text(userinfo['given_name']), text(userinfo['family_name'])].filter(Boolean).join(' ') ||
    text(userinfo['preferred_username']) ||
    email;
  const rawUsername =
    text(userinfo['preferred_username']) || text(userinfo['nickname']) || (email.split('@')[0] ?? email);
  const username =
    rawUsername
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .replace(/^-+/, '')
      .slice(0, 32) || `sso-${sub.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return { sub, issuer, email, name, username };
}

interface DiscoveryDocument {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  userinfo_endpoint?: unknown;
  end_session_endpoint?: unknown;
}

/** Fills missing endpoints from the `.well-known` discovery document. */
export async function discoverEndpoints(discoveryUrl: string): Promise<{
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  endSessionUrl?: string;
}> {
  const normalized = discoveryUrl.trim().replace(/\/\.well-known\/openid-configuration\/?$/, '');
  const candidates = [
    discoveryUrl.trim(),
    `${normalized}/.well-known/openid-configuration`,
  ];
  let lastError = '';
  let target: URL;
  try {
    target = new URL(discoveryUrl.trim());
  } catch {
    throw new Error('The discovery URL is not a valid URL.');
  }
  // Discovery is an admin-set URL, but refusing anything but http(s) keeps a
  // stray `file:`/`data:` from reaching fetch.
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('The discovery URL must be http or https.');
  }
  for (const candidate of new Set(candidates)) {
    try {
      const response = await fetch(candidate, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        lastError = `Discovery request failed (${response.status}).`;
        continue;
      }
      const doc = (await response.json()) as DiscoveryDocument;
      const authUrl = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : '';
      const tokenUrl = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : '';
      const userinfoUrl = typeof doc.userinfo_endpoint === 'string' ? doc.userinfo_endpoint : '';
      if (authUrl.length === 0 || tokenUrl.length === 0 || userinfoUrl.length === 0) {
        lastError = 'The discovery document is missing its endpoints.';
        continue;
      }
      const endSessionUrl =
        typeof doc.end_session_endpoint === 'string' && doc.end_session_endpoint.length > 0
          ? doc.end_session_endpoint
          : undefined;
        return { authUrl, tokenUrl, userinfoUrl, endSessionUrl };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : 'Discovery request failed.';
    }
  }
  throw new Error(lastError || 'Discovery request failed.');
}

/** Resolves the three endpoint URLs: explicit config wins, else discovery. */
export async function resolveEndpoints(config: StoredOidcConfig): Promise<{
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  endSessionUrl?: string;
}> {
  if (
    config.authUrl !== undefined &&
    config.tokenUrl !== undefined &&
    config.userinfoUrl !== undefined
  ) {
    return {
      authUrl: config.authUrl,
      tokenUrl: config.tokenUrl,
      userinfoUrl: config.userinfoUrl,
      endSessionUrl: config.endSessionUrl,
    };
  }
  if (config.discoveryUrl === undefined) {
    throw new Error('Configure the endpoints or a discovery URL first.');
  }
  const discovered = await discoverEndpoints(config.discoveryUrl);
  return {
    authUrl: config.authUrl ?? discovered.authUrl,
    tokenUrl: config.tokenUrl ?? discovered.tokenUrl,
    userinfoUrl: config.userinfoUrl ?? discovered.userinfoUrl,
    endSessionUrl: config.endSessionUrl ?? discovered.endSessionUrl,
  };
}
