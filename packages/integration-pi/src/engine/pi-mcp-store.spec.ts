import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveEngineContext, type McpServerEntry } from '@morse/engine-config';
import { afterEach, describe, expect, it } from 'vitest';

import { PiEngineDefinition, type PiEngineInstance } from './pi-engine.js';
import { PiMcpStore } from './pi-mcp-store.js';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-pi-engine-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Raw = Record<string, unknown>;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): { mcpServers?: Record<string, Raw>; [key: string]: unknown } {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers?: Record<string, Raw>;
    [key: string]: unknown;
  };
}

function readServers(path: string): Record<string, Raw> {
  return readJson(path).mcpServers ?? {};
}

interface Fixture {
  home: string;
  cwd: string;
  instance: PiEngineInstance;
  mcp: PiMcpStore;
  globalPath: string;
  projectPath: string;
}

const engine = new PiEngineDefinition();

/** A user engine over two temp roots, with the paths the tests write to. */
function fixture(): Fixture {
  const home = root();
  const cwd = root();
  const instance = engine.create(resolveEngineContext({ ownership: 'user', home, cwd, env: {} }));
  return {
    home,
    cwd,
    instance,
    mcp: instance.mcp,
    globalPath: join(home, '.pi', 'agent', 'mcp.json'),
    projectPath: join(cwd, '.pi', 'mcp.json'),
  };
}

function byName(items: readonly McpServerEntry[]): Map<string, McpServerEntry> {
  return new Map(items.map((item) => [item.server.name, item]));
}

describe('PiMcpSection', () => {
  it('round-trips a stdio server and never stores enabled: true', () => {
    const { mcp, cwd, globalPath } = fixture();
    const entry = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
      env: { TOKEN: 'secret' },
      cwd: '/work',
      exposure: 'direct',
      description: 'Project files',
      enabled: true,
    };
    writeJson(globalPath, { mcpServers: { files: entry } });

    const listed = mcp.list(cwd);
    expect(listed.issues).toEqual([]);
    expect(listed.items).toHaveLength(1);
    const server = listed.items[0]!.server;
    expect(server).toEqual({
      name: 'files',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
      env: { TOKEN: 'secret' },
      cwd: '/work',
      exposure: 'direct',
      description: 'Project files',
      enabled: true,
    });

    expect(mcp.save(server, 'global')).toMatchObject({
      ok: true,
      path: globalPath,
      scope: 'global',
    });
    expect(readServers(globalPath).files).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
      env: { TOKEN: 'secret' },
      cwd: '/work',
      exposure: 'direct',
      description: 'Project files',
    });
    expect(readServers(globalPath).files).not.toHaveProperty('enabled');
  });

  it('round-trips an http server', () => {
    const { mcp, cwd, globalPath } = fixture();
    const entry = {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    };
    writeJson(globalPath, { mcpServers: { remote: entry } });

    const listed = mcp.list(cwd);
    expect(listed.issues).toEqual([]);
    expect(listed.items[0]!.server).toEqual({
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: true,
    });

    expect(mcp.save(listed.items[0]!.server, 'global').ok).toBe(true);
    expect(readServers(globalPath).remote).toEqual(entry);
  });

  it('infers the transport when type is absent', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcpServers: {
        guessedHttp: { url: 'https://mcp.example.com/mcp' },
        guessedStdio: { command: 'node', args: ['server.js'] },
      },
    });

    const items = byName(mcp.list(cwd).items);
    expect(items.get('guessedHttp')!.server).toMatchObject({ type: 'http' });
    expect(items.get('guessedStdio')!.server).toMatchObject({ type: 'stdio', command: 'node' });
    // The inferred type is written back explicitly.
    expect(mcp.setEnabled('guessedHttp', false, 'global').ok).toBe(true);
    expect(readServers(globalPath).guessedHttp).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
    });
  });

  it('keeps enabled: false and drops enabled: true', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcpServers: {
        off: { command: 'off', enabled: false },
        on: { command: 'on', enabled: true },
      },
    });

    expect(byName(mcp.list(cwd).items).get('off')!.server.enabled).toBe(false);
    expect(byName(mcp.list(cwd).items).get('on')!.server.enabled).toBe(true);

    expect(mcp.setEnabled('on', false, 'global').ok).toBe(true);
    expect(readServers(globalPath).on).toEqual({ type: 'stdio', command: 'on', enabled: false });
    expect(mcp.setEnabled('off', true, 'global').ok).toBe(true);
    expect(readServers(globalPath).off).toEqual({ type: 'stdio', command: 'off' });
  });

  it('lists the global file when no session directory is open', () => {
    const { mcp, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { globalOnly: { command: 'node' } } });
    writeJson(projectPath, { mcpServers: { projectOnly: { command: 'node' } } });

    expect(mcp.list()).toEqual({
      items: [
        {
          server: { name: 'globalOnly', type: 'stdio', command: 'node', enabled: true },
          scope: 'global',
          source: globalPath,
        },
      ],
      issues: [],
    });
    // An empty directory is the same empty-session view.
    expect(mcp.list('').items.map((item) => item.server.name)).toEqual(['globalOnly']);
  });

  it('reports exactly one shape issue for a malformed entry', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, { mcpServers: { bad: { type: 'stdio' } } });

    const listed = mcp.list(cwd);
    const message =
      `${globalPath}: "mcpServers.bad" is a stdio server ` + 'and needs a non-empty "command".';

    expect(listed.items).toEqual([]);
    expect(listed.issues).toEqual([
      {
        file: globalPath,
        fileId: 'mcp',
        scope: 'global',
        pointer: '/mcpServers/bad',
        code: 'shape',
        message,
        fixable: false,
      },
    ]);
  });

  it('keeps a partially malformed args, env and headers on a rewrite', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcpServers: {
        broken: { command: 'npx', args: ['ok', 4], env: { GOOD: 'yes', BAD: 3 } },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { A: 'b', B: 2 } },
      },
    });

    const listed = mcp.list(cwd);
    expect(listed.issues).toContainEqual(
      expect.objectContaining({ code: 'shape', pointer: '/mcpServers/broken/args' }),
    );
    expect(listed.issues).toContainEqual(
      expect.objectContaining({ code: 'shape', pointer: '/mcpServers/broken/env' }),
    );
    expect(listed.issues).toContainEqual(
      expect.objectContaining({ code: 'shape', pointer: '/mcpServers/remote/headers' }),
    );

    expect(mcp.setEnabled('broken', false, 'global').ok).toBe(true);
    expect(mcp.setEnabled('remote', false, 'global').ok).toBe(true);
    // The neutral shape cannot hold the bad values, but a toggle must not erase them.
    expect(readServers(globalPath).broken).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['ok', 4],
      env: { GOOD: 'yes', BAD: 3 },
      enabled: false,
    });
    expect(readServers(globalPath).remote).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { A: 'b', B: 2 },
      enabled: false,
    });
  });

  it('preserves unknown fields through a rewrite', () => {
    const { mcp, globalPath } = fixture();
    const entry = {
      type: 'stdio',
      command: 'npx',
      oauth: { clientId: 'abc', scopes: ['read'] },
      toolExposure: { search: 'hidden' },
      timeout: 30,
    };
    writeJson(globalPath, { mcpServers: { x: entry } });

    expect(mcp.setEnabled('x', false, 'global').ok).toBe(true);
    expect(readServers(globalPath).x).toEqual({ ...entry, enabled: false });
  });

  it('skips a malformed entry with an issue and still lists its siblings', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcpServers: {
        good: { command: 'node' },
        missingCommand: { type: 'stdio' },
        missingUrl: { type: 'http' },
        notAnObject: 3,
      },
    });

    const listed = mcp.list(cwd);
    expect(listed.items.map((item) => item.server.name)).toEqual(['good']);
    expect(listed.issues).toContainEqual(
      expect.objectContaining({
        code: 'shape',
        pointer: '/mcpServers/missingCommand',
        file: globalPath,
        scope: 'global',
      }),
    );
    expect(listed.issues).toContainEqual(
      expect.objectContaining({
        code: 'shape',
        pointer: '/mcpServers/missingUrl',
        file: globalPath,
      }),
    );
    expect(listed.issues).toContainEqual(
      expect.objectContaining({ code: 'shape', pointer: '/mcpServers/notAnObject' }),
    );
    // The issue names the server and the field pi needs.
    expect(
      listed.issues.some(
        (issue) => issue.pointer === '/mcpServers/missingCommand' && /command/.test(issue.message),
      ),
    ).toBe(true);
    expect(
      listed.issues.some(
        (issue) => issue.pointer === '/mcpServers/missingUrl' && /url/.test(issue.message),
      ),
    ).toBe(true);
  });
});

describe('PiMcpStore', () => {
  it('lets a project definition shadow a global one without hiding the global command', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, {
      mcpServers: {
        shadowed: { command: 'global-cmd' },
        pinned: { command: 'pinned-cmd', exposure: 'codemode' },
      },
    });
    writeJson(projectPath, {
      mcpServers: {
        shadowed: { command: 'project-cmd' },
        pinned: { enabled: false },
      },
    });

    const items = byName(mcp.list(cwd).items);

    expect(items.get('shadowed')).toEqual({
      server: { name: 'shadowed', type: 'stdio', command: 'project-cmd', enabled: true },
      scope: 'project',
      source: projectPath,
    });
    expect(items.get('pinned')).toEqual({
      server: {
        name: 'pinned',
        type: 'stdio',
        command: 'pinned-cmd',
        exposure: 'codemode',
        enabled: false,
      },
      scope: 'global',
      source: globalPath,
      override: projectPath,
    });
  });

  it('applies a project exposure pin without re-enabling a disabled global server', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { x: { command: 'npx', enabled: false } } });
    writeJson(projectPath, { mcpServers: { x: { exposure: 'direct' } } });

    expect(byName(mcp.list(cwd).items).get('x')).toEqual({
      server: {
        name: 'x',
        type: 'stdio',
        command: 'npx',
        enabled: false,
        exposure: 'direct',
      },
      scope: 'global',
      source: globalPath,
      override: projectPath,
    });
  });

  it('keeps override-only entries on a managed replacement', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { pinned: { command: 'pinned-cmd' } } });
    writeJson(projectPath, {
      mcpServers: {
        pinned: { enabled: false },
        exposed: { exposure: 'hidden' },
        old: { command: 'old-cmd' },
      },
    });

    const replaced = mcp.replaceManaged(
      [{ name: 'fresh', type: 'stdio', command: 'node' }],
      'project',
    );

    expect(replaced).toMatchObject({ ok: true, path: projectPath, scope: 'project' });
    expect(readServers(projectPath)).toEqual({
      pinned: { enabled: false },
      exposed: { exposure: 'hidden' },
      fresh: { type: 'stdio', command: 'node' },
    });
    // The kept pin still merges onto the global server.
    expect(byName(mcp.list(cwd).items).get('pinned')!.server).toMatchObject({
      command: 'pinned-cmd',
      enabled: false,
    });
  });

  it('does not list an override that has no server to modify', () => {
    const { mcp, cwd, projectPath } = fixture();
    writeJson(projectPath, { mcpServers: { orphan: { enabled: false } } });

    const listed = mcp.list(cwd);
    expect(listed.issues).toEqual([]);
    expect(listed.items).toEqual([]);
  });

  it('writes and clears a project override for a user-level server', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { x: { command: 'npx' } } });

    const disabled = mcp.setEnabled('x', false, 'project', cwd);
    expect(disabled).toMatchObject({
      ok: true,
      path: projectPath,
      scope: 'project',
      override: true,
    });
    expect(readServers(projectPath)).toEqual({ x: { enabled: false } });
    // The defining global entry is untouched.
    expect(readServers(globalPath).x).toEqual({ command: 'npx' });

    const enabled = mcp.setEnabled('x', true, 'project', cwd);
    expect(enabled).toMatchObject({
      ok: true,
      path: projectPath,
      scope: 'project',
      override: true,
    });
    // The emptied entry and the emptied block are deleted.
    expect(readJson(projectPath)).toEqual({});
  });

  it('does not create a project file when there is no override to clear', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { x: { command: 'npx' } } });

    const enabled = mcp.setEnabled('x', true, 'project', cwd);
    expect(enabled).toMatchObject({
      ok: true,
      path: projectPath,
      scope: 'project',
      override: true,
    });
    expect(existsSync(projectPath)).toBe(false);
  });

  it('refuses to override through a malformed project block', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { x: { command: 'npx' } } });
    writeJson(projectPath, { mcpServers: 3 });

    const refused = mcp.setEnabled('x', false, 'project', cwd);
    expect(refused.ok).toBe(false);
    expect(refused.issues).toContainEqual(
      expect.objectContaining({ code: 'shape', file: projectPath, scope: 'project' }),
    );
    expect(readJson(projectPath)).toEqual({ mcpServers: 3 });
  });

  it('keeps the other override keys when pinning enabled', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { x: { command: 'npx' } } });
    writeJson(projectPath, {
      mcpServers: { x: { enabled: false, exposure: 'hidden', toolExposure: { read: 'direct' } } },
    });

    expect(mcp.setEnabled('x', true, 'project', cwd).ok).toBe(true);
    expect(readServers(projectPath).x).toEqual({
      exposure: 'hidden',
      toolExposure: { read: 'direct' },
    });

    expect(mcp.setEnabled('x', false, 'project', cwd).ok).toBe(true);
    expect(readServers(projectPath).x).toEqual({
      enabled: false,
      exposure: 'hidden',
      toolExposure: { read: 'direct' },
    });
  });

  it('keeps an orphan project override toggleable', () => {
    const { mcp, cwd, projectPath } = fixture();
    writeJson(projectPath, { mcpServers: { orphan: { enabled: false } } });

    // No global definition exists, but the legacy manager still let a project
    // override be turned back on.
    const enabled = mcp.setEnabled('orphan', true, 'project', cwd);
    expect(enabled).toMatchObject({
      ok: true,
      path: projectPath,
      scope: 'project',
      override: true,
    });
    expect(readJson(projectPath)).toEqual({});

    // With nothing left to override, the name is unknown again.
    const refused = mcp.setEnabled('orphan', false, 'project', cwd);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('No server named "orphan"');
  });

  it('keeps the other override keys of an orphan when re-enabling it', () => {
    const { mcp, cwd, projectPath } = fixture();
    writeJson(projectPath, { mcpServers: { orphan: { enabled: false, exposure: 'direct' } } });

    expect(mcp.setEnabled('orphan', true, 'project', cwd).ok).toBe(true);
    expect(readServers(projectPath).orphan).toEqual({ exposure: 'direct' });
  });

  it('edits a project definition in place and a global one in the global file', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcpServers: { shared: { command: 'global-cmd' } } });
    writeJson(projectPath, { mcpServers: { shared: { command: 'project-cmd' } } });

    expect(mcp.setEnabled('shared', false, 'project', cwd)).toMatchObject({
      ok: true,
      scope: 'project',
      path: projectPath,
    });
    expect(readServers(projectPath).shared).toEqual({
      type: 'stdio',
      command: 'project-cmd',
      enabled: false,
    });
    expect(readServers(globalPath).shared).toEqual({ command: 'global-cmd' });

    expect(mcp.setEnabled('shared', false, 'global', cwd)).toMatchObject({
      ok: true,
      scope: 'global',
      path: globalPath,
    });
    expect(readServers(globalPath).shared).toEqual({
      type: 'stdio',
      command: 'global-cmd',
      enabled: false,
    });
  });

  it('saves an existing project definition in place and still adds a new one to the target', () => {
    const { mcp, cwd, projectPath, globalPath } = fixture();
    writeJson(projectPath, {
      mcpServers: { shared: { command: 'project-cmd', args: ['a'], oauth: 'kept' } },
    });
    writeJson(globalPath, { mcpServers: { shared: { command: 'global-cmd' } } });

    expect(
      mcp.save({ name: 'shared', type: 'stdio', command: 'changed' }, 'project', cwd),
    ).toMatchObject({ ok: true, path: projectPath, scope: 'project' });
    // The project entry stays the definition; only its edited field moved.
    expect(readServers(projectPath).shared).toMatchObject({ command: 'changed', oauth: 'kept' });
    expect(readServers(globalPath).shared).toEqual({ command: 'global-cmd' });

    expect(
      mcp.upsert('other', { name: 'other', type: 'stdio', command: 'new' }, 'project', cwd),
    ).toMatchObject({ ok: true, path: projectPath });
    expect(readServers(projectPath).other).toBeDefined();
  });

  it('keeps a project override write for a user-level server through upsert', () => {
    const { mcp, cwd, projectPath, globalPath } = fixture();
    writeJson(globalPath, { mcpServers: { shared: { command: 'global-cmd' } } });
    // An override-only entry is not a definition: an add in project scope still
    // replaces it with a real project entry, exactly as before.
    writeJson(projectPath, { mcpServers: { shared: { enabled: false } } });

    expect(
      mcp.upsert('shared', { name: 'shared', type: 'stdio', command: 'project-cmd' }, 'project', cwd),
    ).toMatchObject({ ok: true, path: projectPath });
    expect(readServers(projectPath).shared).toMatchObject({ command: 'project-cmd' });
    expect(readServers(globalPath).shared).toEqual({ command: 'global-cmd' });
  });

  it('writes into an isolated root and refuses its project scope', () => {
    const botRoot = join(root(), 'config');
    const bot = engine.isolated(botRoot, { home: root(), env: {} });
    const mcpPath = join(botRoot, 'mcp.json');
    const mcp = bot.mcp;
    if (!(mcp instanceof PiMcpStore)) {
      throw new Error('an isolated pi engine must supply its MCP store');
    }

    expect(mcp.upsert('x', { name: 'x', type: 'stdio', command: 'node' }, 'global')).toMatchObject({
      ok: true,
      path: mcpPath,
      scope: 'global',
    });
    expect(mcp.list()).toEqual({
      items: [
        {
          server: { name: 'x', type: 'stdio', command: 'node', enabled: true },
          scope: 'global',
          source: mcpPath,
        },
      ],
      issues: [],
    });
    // A bot's own tree is private from the moment it exists.
    expect(statSync(mcpPath).mode & 0o777).toBe(0o600);

    const refused = mcp.upsert('y', { name: 'y', type: 'stdio', command: 'node' }, 'project');
    expect(refused.ok).toBe(false);
    expect(refused.issues).toContainEqual(expect.objectContaining({ code: 'unsupported' }));
    // Without a directory there is no would-be path, so the issue does not fake
    // one; with one, it names the project file that was refused.
    expect(refused.issues[0]?.file).toBe('');
    const withCwd = mcp.upsert(
      'y',
      { name: 'y', type: 'stdio', command: 'node' },
      'project',
      join(botRoot, 'workspace'),
    );
    expect(withCwd.issues[0]).toMatchObject({
      code: 'unsupported',
      file: join(botRoot, 'workspace', '.pi', 'mcp.json'),
    });
  });
});
