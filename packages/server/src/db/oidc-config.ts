import type { Knex } from 'knex';
import type { MorseOidcEnv } from '../app/config.js';

/**
 * The UI-managed OIDC provider: one row (`id = 'default'`) in
 * `morse_oidc_config`, written by the admin settings page. Env-managed hosts
 * never read it — any `MORSE_OIDC_*` knob makes the environment the whole
 * configuration and the page read-only.
 */

export interface StoredOidcConfig {
  enabled: boolean;
  displayName: string;
  discoveryUrl?: string;
  authUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  endSessionUrl?: string;
  clientId?: string;
  /** Present but never logged; returned to an admin's browser on read. */
  clientSecret?: string;
  scopes: string;
  allowSignup: boolean;
}

const ROW_ID = 'default';

interface OidcRow {
  id: string;
  enabled: number;
  display_name: string;
  discovery_url: string | null;
  auth_url: string | null;
  token_url: string | null;
  userinfo_url: string | null;
  end_session_url: string | null;
  client_id: string | null;
  client_secret: string | null;
  scopes: string;
  allow_signup: number;
  updated_at: string | number;
}

function toConfig(row: OidcRow): StoredOidcConfig {
  const text = (value: string | null): string | undefined => value ?? undefined;
  return {
    enabled: row.enabled === 1,
    displayName: row.display_name,
    discoveryUrl: text(row.discovery_url),
    authUrl: text(row.auth_url),
    tokenUrl: text(row.token_url),
    userinfoUrl: text(row.userinfo_url),
    endSessionUrl: text(row.end_session_url),
    clientId: text(row.client_id),
    clientSecret: text(row.client_secret),
    scopes: row.scopes,
    allowSignup: row.allow_signup === 1,
  };
}

/** The admin page's saved provider, if any. Empty when never configured. */
export async function loadOidcConfig(db: Knex): Promise<StoredOidcConfig | undefined> {
  const row = await db('morse_oidc_config').where({ id: ROW_ID }).first();
  return row === undefined ? undefined : toConfig(row as OidcRow);
}

/** Replaces the admin page's saved provider (admin only, never env-managed). */
export async function saveOidcConfig(db: Knex, config: StoredOidcConfig): Promise<void> {
  const empty = (value: string | undefined): string | null =>
    value === undefined || value.trim().length === 0 ? null : value.trim();
  await db('morse_oidc_config')
    .insert({
      id: ROW_ID,
      enabled: config.enabled ? 1 : 0,
      display_name: config.displayName.trim() || 'Single sign-on',
      discovery_url: empty(config.discoveryUrl),
      auth_url: empty(config.authUrl),
      token_url: empty(config.tokenUrl),
      userinfo_url: empty(config.userinfoUrl),
      end_session_url: empty(config.endSessionUrl),
      client_id: empty(config.clientId),
      // An empty secret on save keeps the stored one (edit form sends blank
      // when the reader did not touch it); otherwise it replaces it.
      client_secret:
        config.clientSecret === undefined || config.clientSecret.length === 0
          ? ((await loadOidcConfig(db))?.clientSecret ?? null)
          : config.clientSecret,
      scopes: config.scopes.trim() || 'openid profile email',
      allow_signup: config.allowSignup ? 1 : 0,
      updated_at: Date.now(),
    })
    .onConflict('id')
    .merge();
}

/**
 * The effective provider: env when env-managed, else the admin page's row.
 * Disabled when neither configures a complete provider, so the login page
 * shows no button and the callback refuses.
 */
export function effectiveOidc(
  env: MorseOidcEnv,
  envManaged: boolean,
  stored: StoredOidcConfig | undefined,
): (StoredOidcConfig & { managedByEnv: boolean }) | undefined {
  if (envManaged) {
    return {
      enabled: env.enabled,
      displayName: env.displayName,
      discoveryUrl: env.discoveryUrl,
      authUrl: env.authUrl,
      tokenUrl: env.tokenUrl,
      userinfoUrl: env.userinfoUrl,
      endSessionUrl: env.endSessionUrl,
      clientId: env.clientId,
      clientSecret: env.clientSecret,
      scopes: env.scopes,
      allowSignup: env.allowSignup,
      managedByEnv: true,
    };
  }
  if (stored === undefined) {
    return undefined;
  }
  return { ...stored, managedByEnv: false };
}

/** Complete enough to start a login: endpoints (or discovery) plus client id. */
export function isOidcUsable(config: StoredOidcConfig): boolean {
  const hasEndpoints =
    (config.authUrl !== undefined && config.tokenUrl !== undefined && config.userinfoUrl !== undefined) ||
    config.discoveryUrl !== undefined;
  return config.clientId !== undefined && config.clientId.length > 0 && hasEndpoints;
}
