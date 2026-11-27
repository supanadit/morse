import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';
import { newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRouter, SessionTranscriptStore, silentLogger } from '@morse/system';
import type { AuthUser, HostToClientMessage } from '@morse/protocol';
import { migrateToLatest } from '../../db/migrations.js';
import { PgSessionStore } from '../../db/pg-store.js';
import { createToken, resolveToken } from '../../db/tokens.js';
import { createUser, findUserById } from '../../db/users.js';
import { MorseSessionFactory } from './session-factory.service.js';
import type { MorseServerConfig } from '../../app/config.js';

/**
 * Per-user bundles: two login users on one host cannot see each other's
 * sessions, workbench or drafts, and only admins reach `admin/*`. Backed by
 * in-memory pg; engine spawning is out of scope (no engines registered).
 */
describe('MorseSessionFactory multi-user bundles', () => {
  let db: Knex;
  let dataDir: string;
  let factory: MorseSessionFactory;
  let admin: { id: string };
  let bob: { id: string };

  const userOf = (id: string, role: 'admin' | 'regular', username: string): AuthUser => ({
    id,
    username,
    role,
  });

  beforeEach(async () => {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    db = mem.adapters.createKnex(0, { client: 'pg' }) as unknown as Knex;
    await migrateToLatest(db, silentLogger);
    dataDir = mkdtempSync(join(tmpdir(), 'morse-bundles-'));
    admin = await createUser(db, { username: 'adit', password: 'supersecret' });
    bob = await createUser(db, { username: 'bob', password: 'supersecret2' });
    const router = new AgentRouter({
      store: new PgSessionStore(db),
      defaultWorkspace: { cwd: '/work', name: 'work' },
      logger: silentLogger,
    });
    const config = {
      multiuser: true,
      dataDir,
      workspace: { cwd: '/work', name: 'work' },
      projects: [],
      updateCheck: false,
      selfUpdate: false,
    } as unknown as MorseServerConfig;
    const fakeRegistry = {
      subscribe: () => () => undefined,
      onRemoval: () => () => undefined,
      activeKeyOf: () => undefined,
      hotKeys: () => [] as string[],
      stateOf: () => undefined,
      defaultWorkspace: { cwd: '/work', name: 'work' },
      draftDefaults: async () => undefined,
      listSessions: async () => [],
      sessionCounts: async () => [] as [string, number][],
      listProjects: async () => [],
      searchSessions: async () => [],
      dispose: async () => undefined,
    };
    const sharedRouter = {
      registrations: () => [],
      defaultExtras: () => undefined,
      engineOptions: () => [],
      extrasFor: () => undefined,
      registeredEngines: () => [],
      dispose: async () => undefined,
    };
    factory = new MorseSessionFactory(
      fakeRegistry as never,
      new SessionTranscriptStore(),
      { canOpen: () => true } as never,
      silentLogger,
      config,
      undefined,
      sharedRouter as never,
      {} as never,
      db,
      undefined,
    );
    // Seed one session per user straight into the store.
    await new PgSessionStore(db, admin.id).write({
      version: 2,
      id: 'aaa',
      title: 'Admin session',
      cwd: '/work',
      engineRef: { engine: 'pi', sessionId: 'e1' },
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
    });
    await new PgSessionStore(db, bob.id).write({
      version: 2,
      id: 'bbb',
      title: 'Bob session',
      cwd: '/work',
      engineRef: { engine: 'pi', sessionId: 'e2' },
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
    });
  });

  afterEach(async () => {
    await factory.disposeBundles().catch(() => undefined);
    await db.destroy().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses connections with no login user', () => {
    expect(() => factory.createFor(() => undefined)).toThrow(/Login is required/);
  });

  it('fences users to their own workspace root when configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'morse-wsroot-'));
    try {
      const config = {
        multiuser: true,
        dataDir,
        workspace: { cwd: '/work', name: 'work' },
        workspaceRoot: root,
        projects: [],
        updateCheck: false,
        selfUpdate: false,
      } as unknown as MorseServerConfig;
      const fakeRegistry = {
        subscribe: () => () => undefined,
        onRemoval: () => () => undefined,
        activeKeyOf: () => undefined,
        hotKeys: () => [] as string[],
        stateOf: () => undefined,
        defaultWorkspace: { cwd: '/work', name: 'work' },
        draftDefaults: async () => undefined,
        listSessions: async () => [],
        sessionCounts: async () => [] as [string, number][],
        listProjects: async () => [],
        searchSessions: async () => [],
        dispose: async () => undefined,
      };
      const sharedRouter = {
        registrations: () => [],
        defaultExtras: () => undefined,
        engineOptions: () => [],
        extrasFor: () => undefined,
        registeredEngines: () => [],
        dispose: async () => undefined,
      };
      const fenced = new MorseSessionFactory(
        fakeRegistry as never,
        new SessionTranscriptStore(),
        { canOpen: () => true } as never,
        silentLogger,
        config,
        undefined,
        sharedRouter as never,
        {} as never,
        db,
        undefined,
      );
      const messages: HostToClientMessage[] = [];
      const controller = fenced.createFor((message) => messages.push(message), {
        user: userOf(admin.id, 'admin', 'adit'),
      });
      await controller.handleClientMessage({
        type: 'host/command',
        payload: { requestId: 'f1', command: 'listDirectories', args: { path: '/' } },
      });
      // Admins keep the global policy: the filesystem stays browsable.
      const outside = messages.at(-1) as unknown as { payload: { data: { canOpen: boolean } } };
      expect(outside.payload.data.canOpen).toBe(true);
      await controller.handleClientMessage({
        type: 'host/command',
        payload: { requestId: 'f2', command: 'listDirectories', args: { path: join(root, 'adit') } },
      });
      const inside = messages.at(-1) as unknown as { payload: { data: { canOpen: boolean } } };
      expect(inside.payload.data.canOpen).toBe(true);

      // A regular user is fenced: `/` clamps back to their own workspace, and
      // the shortcuts never leave it.
      const bobMessages: HostToClientMessage[] = [];
      const forBob = fenced.createFor((message) => bobMessages.push(message), {
        user: userOf(bob.id, 'regular', 'bob'),
      });
      await forBob.handleClientMessage({
        type: 'host/command',
        payload: { requestId: 'f3', command: 'listDirectories', args: { path: '/' } },
      });
      const clamped = bobMessages.at(-1) as unknown as {
        payload: { data: { path: string; parent?: string; roots: { path: string }[]; canOpen: boolean } };
      };
      expect(clamped.payload.data.path).toBe(join(root, 'bob'));
      expect(clamped.payload.data.canOpen).toBe(true);
      expect(clamped.payload.data.parent).toBeUndefined();
      for (const shortcut of clamped.payload.data.roots) {
        expect(shortcut.path.startsWith(join(root, 'bob'))).toBe(true);
      }
      await forBob.dispose().catch(() => undefined);
      await controller.dispose().catch(() => undefined);
      await fenced.disposeBundles().catch(() => undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets admins list users and refuses regulars at the command', async () => {
    const adminMessages: HostToClientMessage[] = [];
    const forAdmin = factory.createFor((message) => adminMessages.push(message), {
      user: userOf(admin.id, 'admin', 'adit'),
    });
    await forAdmin.handleClientMessage({
      type: 'host/command',
      payload: { requestId: '1', command: 'adminUsers' },
    });
    const answer = adminMessages.at(-1);
    expect(answer?.type).toBe('host/command/result');
    const users = (answer as { payload: { data: { username: string }[] } }).payload.data;
    expect(users.map((u) => u.username).sort()).toEqual(['adit', 'bob']);

    const bobMessages: HostToClientMessage[] = [];
    const forBob = factory.createFor((message) => bobMessages.push(message), {
      user: userOf(bob.id, 'regular', 'bob'),
    });
    await forBob.handleClientMessage({
      type: 'host/command',
      payload: { requestId: '2', command: 'adminUsers' },
    });
    // Bob is refused at the real boundary, not just hidden in the UI.
    const refused = bobMessages.at(-1);
    expect(refused?.type).toBe('host/command/result');
    expect((refused as { payload: { ok: boolean; error?: string } }).payload.ok).toBe(false);
    await forAdmin.dispose().catch(() => undefined);
    await forBob.dispose().catch(() => undefined);
  });

  it('creates users and deletes them with their sessions', async () => {
    const adminMessages: HostToClientMessage[] = [];
    const forAdmin = factory.createFor((message) => adminMessages.push(message), {
      user: userOf(admin.id, 'admin', 'adit'),
    });
    const ask = async (
      command: 'adminCreateUser' | 'adminSetRole' | 'adminUpdateUser' | 'adminDeleteUser',
      args: Record<string, unknown>,
    ) => {
      await forAdmin.handleClientMessage({ type: 'host/command', payload: { requestId: command, command, args } });
      return adminMessages.at(-1) as { payload: { ok: boolean; data?: unknown; error?: string } };
    };
    const created = await ask('adminCreateUser', { username: 'carol', password: 'supersecret3', role: 'regular' });
    expect(created.payload.ok).toBe(true);
    const carolId = (created.payload.data as { id: string }).id;
    await new PgSessionStore(db, carolId).write({
      version: 2,
      id: 'ccc',
      title: 'Carol session',
      cwd: '/work',
      engineRef: { engine: 'pi', sessionId: 'e3' },
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
    });
    const deleted = await ask('adminDeleteUser', { userId: carolId });
    expect(deleted.payload.ok).toBe(true);
    // Her sessions went with her; everyone else's stayed.
    expect(await new PgSessionStore(db).list()).toHaveLength(2);
    await forAdmin.dispose().catch(() => undefined);
  });

  it('lets admins edit a profile and password, revoking sessions on a password change', async () => {
    const messages: HostToClientMessage[] = [];
    const forAdmin = factory.createFor((message) => messages.push(message), {
      user: userOf(admin.id, 'admin', 'adit'),
    });
    const ask = async (args: Record<string, unknown>) => {
      await forAdmin.handleClientMessage({
        type: 'host/command',
        payload: { requestId: 'edit', command: 'adminUpdateUser', args },
      });
      return messages.at(-1) as { payload: { ok: boolean; error?: string } };
    };

    const token = await createToken(db, bob.id);
    const edited = await ask({ userId: bob.id, name: 'Bob Builder', email: 'bob@example.com' });
    expect(edited.payload.ok).toBe(true);
    expect(await findUserById(db, bob.id)).toMatchObject({
      name: 'Bob Builder',
      email: 'bob@example.com',
    });
    // Editing a profile leaves the user's login session alone.
    expect(await resolveToken(db, token)).toMatchObject({ id: bob.id });

    expect((await ask({ userId: bob.id, email: 'not-an-email' })).payload.ok).toBe(false);
    expect((await ask({ userId: bob.id, password: 'short' })).payload.ok).toBe(false);

    expect((await ask({ userId: bob.id, password: 'newsecret9' })).payload.ok).toBe(true);
    expect(await resolveToken(db, token)).toBeUndefined();
    await forAdmin.dispose().catch(() => undefined);
  });
});
