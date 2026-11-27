import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';
import { newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '@morse/system';
import { migrateToLatest } from '../../db/migrations.js';
import { createToken } from '../../db/tokens.js';
import { adoptLocalRowsToUser } from '../../db/factory.js';
import { createUser, verifyUser } from '../../db/users.js';
import { AuthController } from './auth.controller.js';
import type { MorseServerConfig } from '../../app/config.js';

/**
 * The HTTP login surface, against in-memory pg: setup-once semantics, login
 * cookies, logout revocation and the status probe the login page boots from.
 */
describe('AuthController', () => {
  let db: Knex;
  let dataDir: string;
  let controller: AuthController;
  let config: MorseServerConfig;

  const response = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    };
  };

  beforeEach(async () => {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    db = mem.adapters.createKnex(0, { client: 'pg' }) as unknown as Knex;
    await migrateToLatest(db, silentLogger);
    dataDir = mkdtempSync(join(tmpdir(), 'morse-auth-'));
    config = { multiuser: true, dataDir } as MorseServerConfig;
    controller = new AuthController(config, silentLogger, db);
  });

  afterEach(async () => {
    await db.destroy().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports setup-required before the first user and refuses setup twice', async () => {
    expect(await controller.status({ headers: {} })).toEqual({
      multiuser: true,
      setupRequired: true,
    });
    const res = response();
    const created = await controller.setup({ username: 'Adit', password: 'supersecret' }, res as never);
    expect(created.user.role).toBe('admin');
    expect(res.headers['Set-Cookie']).toMatch(/^morse_token=/);
    await expect(controller.setup({ username: 'x', password: 'supersecret' }, response() as never)).rejects.toMatchObject({
      status: 403,
    });
    expect(await controller.status({ headers: {} })).toMatchObject({ setupRequired: false });
  });

  it('logs in with the password, rejects a miss, and revokes on logout', async () => {
    await createUser(db, { username: 'adit', password: 'supersecret' });
    const good = response();
    const logged = await controller.login({ username: 'adit', password: 'supersecret' }, good as never);
    expect(logged.user.username).toBe('adit');
    const raw = good.headers['Set-Cookie'].split(';')[0]!.split('=')[1]!;

    // The cookie resolves (the gateway uses the same path).
    const { authUserOfRequest } = await import('./auth.controller.js');
    expect(await authUserOfRequest(db, { cookie: `morse_token=${raw}` })).toMatchObject({
      username: 'adit',
    });

    await expect(controller.login({ username: 'adit', password: 'nope-nope' }, response() as never)).rejects.toMatchObject({
      status: 401,
    });
    await controller.logout({ headers: { cookie: `morse_token=${raw}` } }, response() as never);
    expect(await authUserOfRequest(db, { cookie: `morse_token=${raw}` })).toBeUndefined();
  });

  it('moves pre-login local rows to the first admin on setup', async () => {
    await db('morse_sessions').insert({
      user_id: 'local',
      morse_id: 'm1',
      title: 'Old',
      cwd: '/repo',
      engine: 'pi',
      engine_session_id: 'e1',
      created_at: 1,
      updated_at: 2,
      message_count: 0,
    });
    const created = await controller.setup({ username: 'adit', password: 'supersecret' }, response() as never);
    expect(await db('morse_sessions').where({ user_id: created.user.id }).select('morse_id')).toHaveLength(1);
    expect(verifyUser).toBeDefined();
  });

  it('refuses everything on single-user hosts', async () => {
    const single = new AuthController({ multiuser: false, dataDir } as MorseServerConfig, silentLogger, undefined);
    await expect(single.setup({ username: 'a', password: 'supersecret' }, response() as never)).rejects.toMatchObject({
      status: 404,
    });
    await expect(single.login({ username: 'a', password: 'supersecret' }, response() as never)).rejects.toMatchObject({
      status: 404,
    });
    expect(await single.status({ headers: {} })).toEqual({ multiuser: false, setupRequired: false });
  });

  it('expires tokens and drops them on sight', async () => {
    const user = await createUser(db, { username: 'adit', password: 'supersecret' });
    const token = await createToken(db, user.id);
    const { authUserOfRequest } = await import('./auth.controller.js');
    await db('morse_tokens').update({ expires_at: Date.now() - 1 });
    expect(await authUserOfRequest(db, { cookie: `morse_token=${token}` })).toBeUndefined();
    expect(await db('morse_tokens').select('*')).toHaveLength(0);
  });

  it('ends SSO sessions through the provider logout, password sessions locally', async () => {
    const { saveOidcConfig } = await import('../../db/oidc-config.js');
    const { isOidcSession } = await import('../../db/tokens.js');
    await saveOidcConfig(db, {
      enabled: true,
      displayName: 'Keycloak',
      discoveryUrl: undefined,
      authUrl: 'https://id.example.com/auth',
      tokenUrl: 'https://id.example.com/token',
      userinfoUrl: 'https://id.example.com/userinfo',
      endSessionUrl: 'https://id.example.com/logout',
      clientId: 'morse',
      clientSecret: undefined,
      scopes: 'openid profile email',
      allowSignup: true,
    });
    const user = await createUser(db, { username: 'adit', password: 'supersecret' });
    const passwordToken = await createToken(db, user.id);
    const ssoToken = await createToken(db, user.id, true);
    expect(await isOidcSession(db, passwordToken)).toBe(false);
    expect(await isOidcSession(db, ssoToken)).toBe(true);

    const redirecting = () => {
      const headers: Record<string, string> = {};
      let target = '';
      return {
        headers,
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
        redirect: (url: string) => {
          target = url;
        },
        target: () => target,
      };
    };

    // A password login ends at the login page: no provider session to close.
    const plain = redirecting();
    await controller.oidcLogout(
      { headers: { cookie: `morse_token=${passwordToken}`, host: 'localhost:4399' } },
      plain as never,
    );
    expect(plain.target()).toBe('/');

    // An SSO login bounces through the provider's end-session endpoint, with
    // the way back and the client named — that is what lets the next login
    // pick a different user instead of reusing the last one.
    const sso = redirecting();
    await controller.oidcLogout(
      { headers: { cookie: `morse_token=${ssoToken}`, host: 'localhost:4399' } },
      sso as never,
    );
    const url = new URL(sso.target());
    expect(`${url.origin}${url.pathname}`).toBe('https://id.example.com/logout');
    expect(url.searchParams.get('client_id')).toBe('morse');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:4399/');
  });

  it('lets a member set their own password, proving the current one first', async () => {
    const user = await createUser(db, { username: 'adit', password: 'supersecret' });
    const token = await createToken(db, user.id);
    const session = { headers: { cookie: `morse_token=${token}` } };
    expect(await controller.passwordStatus(session)).toEqual({ needsCurrent: true });
    await expect(
      controller.changePassword(session, { currentPassword: 'nope-nope-nope', newPassword: 'newsecret1' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(await controller.changePassword(session, { currentPassword: 'supersecret', newPassword: 'newsecret1' })).toEqual({
      ok: true,
    });
    expect(await verifyUser(db, 'adit', 'supersecret')).toBeUndefined();
    expect(await verifyUser(db, 'adit', 'newsecret1')).toBeDefined();
  });

  it('lets SSO-provisioned members set a password with no current one', async () => {
    const { createOidcUser } = await import('../../db/users.js');
    const created = await createOidcUser(db, {
      username: 'sso.adit',
      name: 'SSO Adit',
      email: 'sso@example.com',
      sub: 'sub-1',
      issuer: 'https://id.example.com',
    });
    expect(created?.passwordSet).toBe(false);
    const session = { headers: { cookie: `morse_token=${await createToken(db, created!.id, true)}` } };
    expect(await controller.passwordStatus(session)).toEqual({ needsCurrent: false });
    expect(await controller.changePassword(session, { newPassword: 'localpass1' })).toEqual({ ok: true });
    expect(await verifyUser(db, 'sso.adit', 'localpass1')).toBeDefined();
  });

  it('refuses password login and setup under SSO-only', async () => {
    const admin = await createUser(db, { username: 'adit', password: 'supersecret' });
    const adminSession = { headers: { cookie: `morse_token=${await createToken(db, admin.id)}` } };
    await expect(controller.oidcSave(adminSession, {
      enabled: true,
      displayName: 'Keycloak',
      authUrl: 'https://id.example.com/auth',
      tokenUrl: 'https://id.example.com/token',
      userinfoUrl: 'https://id.example.com/userinfo',
      clientId: 'morse',
      allowPassword: false,
    })).resolves.toEqual({ ok: true });
    await expect(
      controller.login({ username: 'adit', password: 'supersecret' }, response() as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.setup({ username: 'x', password: 'supersecret' }, response() as never),
    ).rejects.toMatchObject({ status: 403 });
    const status = await controller.status({ headers: {} });
    expect(status.oidc).toEqual({ enabled: true, displayName: 'Keycloak', allowPassword: false });
  });

  it('adoptLocalRowsToUser is a no-op helper the specs keep honest', async () => {
    expect(await adoptLocalRowsToUser(db, 'nobody')).toBe(0);
  });
});
