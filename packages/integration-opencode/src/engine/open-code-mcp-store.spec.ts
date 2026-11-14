import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { resolveEngineContext, type McpServerEntry } from '@morse/engine-config';
import { afterEach, describe, expect, it } from 'vitest';

import { OpenCodeEngineDefinition, type OpenCodeEngineInstance } from './open-code-engine.js';
import { OpenCodeMcpStore } from './open-code-mcp-store.js';

type Raw = Record<string, unknown>;

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-opencode-engine-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): { mcp?: Record<string, Raw>; [key: string]: unknown } {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    mcp?: Record<string, Raw>;
    [key: string]: unknown;
  };
}

function readServers(path: string): Record<string, Raw> {
  return readJson(path).mcp ?? {};
}

interface Fixture {
  home: string;
  cwd: string;
  instance: OpenCodeEngineInstance;
  mcp: OpenCodeMcpStore;
  globalPath: string;
  projectPath: string;
}

const engine = new OpenCodeEngineDefinition();

/** A user engine over two temp roots, with the paths the tests write to. */
function fixture(): Fixture {
  const home = root();
  const cwd = root();
  const instance = engine.create(resolveEngineContext({ ownership: 'user', home, cwd, env: {} }));
  // Guard the shared fixture once: no test may write outside its own tree, even
  // if a stray `opencode.json` exists in an ancestor of the temp root.
  assertUnder(cwd, instance.paths('config', 'project', cwd).write);
  assertUnder(home, instance.paths('config', 'global').write);
  return {
    home,
    cwd,
    instance,
    mcp: instance.mcp,
    globalPath: join(home, '.config', 'opencode', 'opencode.json'),
    projectPath: join(cwd, 'opencode.json'),
  };
}

function byName(items: readonly McpServerEntry[]): Map<string, McpServerEntry> {
  return new Map(items.map((item) => [item.server.name, item]));
}

/**
 * A write target must be inside this test's temp tree. A stray `/tmp/opencode.json`
 * (or `/opencode.json`) must never be the file a save rewrites.
 */
function assertUnder(root: string, path: string | undefined): void {
  expect(path).toBeDefined();
  expect(path === root || path!.startsWith(`${root}${sep}`)).toBe(true);
}

describe('OpenCodeMcpSection', () => {
  it('lists nothing for a tree with no config file', () => {
    const { mcp, cwd } = fixture();

    expect(mcp.list(cwd)).toEqual({ items: [], issues: [] });
  });

  it('round-trips a local server and never stores enabled: true', () => {
    const { mcp, cwd, globalPath } = fixture();
    const entry = {
      type: 'local',
      command: ['npx', 'one'],
      environment: { A: '1' },
      cwd: '/w',
    };
    writeJson(globalPath, { mcp: { one: entry } });

    const listed = mcp.list(cwd);
    expect(listed.issues).toEqual([]);
    expect(listed.items.map((item) => item.server)).toEqual([
      {
        name: 'one',
        type: 'stdio',
        command: 'npx',
        args: ['one'],
        env: { A: '1' },
        cwd: '/w',
        enabled: true,
      },
    ]);
    expect(listed.items[0]).toMatchObject({ scope: 'global', source: globalPath });

    const server = listed.items[0]!.server;
    expect(mcp.save(server, 'global')).toMatchObject({ ok: true, path: globalPath });
    // Same spelling OpenCode reads, with `enabled: true` (the default) dropped.
    expect(readServers(globalPath).one).toEqual(entry);
  });

  it('round-trips a remote server', () => {
    const { mcp, cwd, globalPath } = fixture();
    const entry = {
      type: 'remote',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer x' },
    };
    writeJson(globalPath, { mcp: { remote_one: entry } });

    const listed = mcp.list(cwd);
    expect(listed.issues).toEqual([]);
    expect(listed.items[0]!.server).toEqual({
      name: 'remote_one',
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer x' },
      enabled: true,
    });

    expect(mcp.save(listed.items[0]!.server, 'global')).toMatchObject({ ok: true });
    expect(readServers(globalPath).remote_one).toEqual(entry);
  });

  it('round-trips a description and keeps a stored one when it is omitted', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcp: { one: { type: 'local', command: ['x'], description: 'Project files' } },
    });

    const listed = mcp.list(cwd);
    expect(listed.items[0]!.server.description).toBe('Project files');

    // Omitted: the entry's own text stays instead of being erased.
    mcp.save({ ...listed.items[0]!.server, description: undefined }, 'global');
    expect(readServers(globalPath).one).toMatchObject({ description: 'Project files' });

    // Provided: it is written.
    mcp.save({ ...listed.items[0]!.server, description: 'Changed' }, 'global');
    expect(readServers(globalPath).one).toMatchObject({ description: 'Changed' });
    expect(mcp.list(cwd).items[0]!.server.description).toBe('Changed');
  });

  it('reports a malformed environment or headers record but keeps it on save', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcp: {
        local_bad_env: { type: 'local', command: ['x'], environment: { A: 1 } },
        remote_bad_headers: { type: 'remote', url: 'https://x', headers: { B: 2 } },
      },
    });

    const listed = mcp.list(cwd);
    expect(listed.items.map((item) => item.server.name)).toEqual([
      'local_bad_env',
      'remote_bad_headers',
    ]);
    expect(listed.items[0]!.server.env).toBeUndefined();
    expect(listed.items[1]!.server.headers).toBeUndefined();
    expect(listed.issues.map((issue) => [issue.pointer, issue.code])).toEqual([
      ['/mcp/local_bad_env/environment', 'shape'],
      ['/mcp/remote_bad_headers/headers', 'shape'],
    ]);

    for (const entry of listed.items) {
      expect(mcp.save(entry.server, 'global')).toMatchObject({ ok: true });
    }
    // OpenCode would still read these records; a save must not delete them.
    expect(readServers(globalPath)).toEqual({
      local_bad_env: { type: 'local', command: ['x'], environment: { A: 1 } },
      remote_bad_headers: { type: 'remote', url: 'https://x', headers: { B: 2 } },
    });
  });

  it('treats a whitespace-only url or cwd as missing', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcp: {
        blank_url: { type: 'remote', url: '   ' },
        blank_cwd: { type: 'local', command: ['x'], cwd: '  ' },
      },
    });

    const listed = mcp.list(cwd);
    expect(listed.items.map((item) => item.server.name)).toEqual(['blank_cwd']);
    expect(listed.items[0]!.server.cwd).toBeUndefined();
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({ pointer: '/mcp/blank_url', code: 'shape' });
    expect(listed.issues[0]!.message).toMatch(/remote MCP server "blank_url" needs a "url"/);

    expect(mcp.save(listed.items[0]!.server, 'global')).toMatchObject({ ok: true });
    expect(readServers(globalPath).blank_cwd).toEqual({ type: 'local', command: ['x'] });
  });

  it('keeps enabled: false and every unknown field through a save', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcp: {
        one: {
          type: 'remote',
          url: 'https://x',
          enabled: false,
          oauth: { a: 1 },
          timeout: 30,
        },
      },
    });

    const listed = mcp.list(cwd);
    expect(listed.items[0]!.server.enabled).toBe(false);
    const saved = mcp.save({ ...listed.items[0]!.server, enabled: true }, 'global');
    expect(saved).toMatchObject({ ok: true });
    expect(readServers(globalPath).one).toEqual({
      type: 'remote',
      url: 'https://x',
      oauth: { a: 1 },
      timeout: 30,
    });
  });

  it('skips a malformed entry with a pointer and lists its siblings', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, {
      mcp: {
        good: { type: 'local', command: ['x'] },
        no_command: { type: 'local', command: 'npx' },
        no_url: { type: 'remote' },
        no_type: { command: ['x'] },
      },
    });

    const listed = mcp.list(cwd);
    expect(listed.items.map((item) => item.server.name)).toEqual(['good']);
    expect(listed.issues.map((issue) => [issue.pointer, issue.code])).toEqual([
      ['/mcp/no_command', 'shape'],
      ['/mcp/no_url', 'shape'],
      ['/mcp/no_type', 'shape'],
    ]);
    expect(listed.issues[0]!.message).toMatch(
      /local MCP server "no_command" needs a non-empty "command"/,
    );
    expect(listed.issues[1]!.message).toMatch(/remote MCP server "no_url" needs a "url"/);
    expect(listed.issues[2]!.message).toMatch(/needs "type" of "local" or "remote"/);
  });

  it('reports an mcp key that is not an object instead of throwing', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, { mcp: ['nope'] });

    const listed = mcp.list(cwd);
    expect(listed.items).toEqual([]);
    expect(listed.issues.map((issue) => [issue.pointer, issue.code])).toEqual([['/mcp', 'shape']]);
    expect(listed.issues[0]!.message).toMatch(/"mcp" must be an object/);
  });

  it('reads JSONC and refuses a user write until the file is normalized', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeText(
      globalPath,
      '{\n  // hand edit: keep the comment until it is fixed\n  "mcp": { "one": { "type": "local", "command": ["x"] } }\n}\n',
    );

    const listed = mcp.list(cwd);
    expect(listed.items.map((item) => item.server.name)).toEqual(['one']);
    expect(listed.issues.map((issue) => issue.code)).toEqual(['normalize']);

    const refused = mcp.save(listed.items[0]!.server, 'global');
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'normalize', fixable: true });

    expect(mcp.normalize('global')).toMatchObject({ ok: true });
    expect(mcp.save(listed.items[0]!.server, 'global')).toMatchObject({ ok: true });
  });

  it('refuses a project jsonc write until that file is normalized', () => {
    const { mcp, cwd } = fixture();
    const projectJsonc = join(cwd, 'opencode.jsonc');
    writeText(
      projectJsonc,
      '{\n  // project notes\n  "mcp": { "one": { "type": "local", "command": ["x"] } }\n}\n',
    );

    const listed = mcp.list(cwd);
    expect(listed.items.map((item) => item.server.name)).toEqual(['one']);
    expect(listed.items[0]!.source).toBe(projectJsonc);

    const refused = mcp.save(listed.items[0]!.server, 'project', cwd);
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({
      code: 'normalize',
      fixable: true,
      file: projectJsonc,
    });

    expect(mcp.normalize('project', cwd)).toMatchObject({ ok: true });
    expect(mcp.save(listed.items[0]!.server, 'project', cwd)).toMatchObject({
      ok: true,
      path: projectJsonc,
    });
    expect(readServers(projectJsonc).one).toEqual({ type: 'local', command: ['x'] });
  });

  it('prefers a project .opencode entry over a nearer direct file', () => {
    const { mcp, cwd } = fixture();
    const shared = join(cwd, '.opencode', 'opencode.jsonc');
    writeText(shared, '{\n  "mcp": { "shared": { "type": "local", "command": ["shared"] } }\n}\n');
    writeJson(join(cwd, 'opencode.json'), {
      mcp: { shared: { type: 'local', command: ['direct'] } },
    });

    const listed = byName(mcp.list(cwd).items);
    expect(listed.get('shared')).toMatchObject({ scope: 'project', source: shared });
    expect(listed.get('shared')!.server.command).toBe('shared');
    // A save lands where OpenCode reads the effective entry from.
    expect(mcp.paths('project', cwd).write).toBe(shared);
  });

  it('lets a project entry replace a same-named global one', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, {
      mcp: {
        shared: { type: 'local', command: ['global'] },
        only_global: { type: 'local', command: ['g'] },
      },
    });
    writeJson(projectPath, { mcp: { shared: { type: 'local', command: ['project'] } } });

    const listed = byName(mcp.list(cwd).items);
    expect(listed.get('shared')!.server).toMatchObject({
      command: 'project',
      name: 'shared',
    });
    expect(listed.get('shared')).toMatchObject({ scope: 'project', source: projectPath });
    expect(listed.get('only_global')).toMatchObject({ scope: 'global', source: globalPath });
  });

  it('drops enabled: true through setEnabled and keeps the unknown fields', () => {
    const { mcp, globalPath } = fixture();
    writeJson(globalPath, {
      mcp: {
        one: { type: 'local', command: ['x'], enabled: false, timeout: 5 },
      },
    });

    expect(mcp.setEnabled('one', true, 'global')).toMatchObject({ ok: true, path: globalPath });
    expect(readServers(globalPath).one).toEqual({ type: 'local', command: ['x'], timeout: 5 });

    expect(mcp.setEnabled('one', false, 'global')).toMatchObject({ ok: true });
    expect(readServers(globalPath).one).toEqual({
      type: 'local',
      command: ['x'],
      timeout: 5,
      enabled: false,
    });
  });

  it('refuses a project edit of a user-level server: OpenCode has no override', () => {
    const { mcp, cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { mcp: { one: { type: 'local', command: ['x'] } } });

    const refused = mcp.setEnabled('one', false, 'project', cwd);
    expect(refused.ok).toBe(false);
    expect(refused.issues?.map((issue) => issue.code)).toContain('unsupported');
    expect(refused.message).toMatch(/cannot write a project override/);
    expect(refused.path).toBe(globalPath);
    expect(readServers(globalPath).one).toEqual({ type: 'local', command: ['x'] });
    expect(() => readFileSync(projectPath, 'utf8')).toThrow();
  });

  it('edits a project definition in place', () => {
    const { mcp, cwd, projectPath } = fixture();
    writeJson(projectPath, { mcp: { one: { type: 'local', command: ['x'] } } });

    expect(mcp.setEnabled('one', false, 'project', cwd)).toMatchObject({
      ok: true,
      path: projectPath,
      scope: 'project',
    });
    expect(readServers(projectPath).one).toEqual({
      type: 'local',
      command: ['x'],
      enabled: false,
    });
  });

  it('does nothing for a missing server', () => {
    const { mcp, globalPath } = fixture();
    writeJson(globalPath, { mcp: {} });

    const missing = mcp.setEnabled('missing', true, 'global');
    expect(missing.ok).toBe(false);
    expect(missing.issues?.[0]?.code).toBe('name');
    expect(readServers(globalPath)).toEqual({});
  });

  it('removes an entry, deleting the block once it empties', () => {
    const { mcp, globalPath } = fixture();
    writeJson(globalPath, { mcp: { one: { type: 'local', command: ['x'] } } });

    expect(mcp.remove('one', 'global')).toMatchObject({ ok: true });
    expect(readJson(globalPath)).toEqual({});
    expect(mcp.remove('one', 'global').ok).toBe(false);
  });

  it('refuses a removal from a read fallback', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, { mcp: {} });
    writeJson(join(cwd, 'opencode.json'), {
      mcp: { project_only: { type: 'local', command: ['p'] } },
    });

    const refused = mcp.remove('project_only', 'global');
    expect(refused.ok).toBe(false);
    expect(refused.issues?.[0]?.code).toBe('unsupported');
    expect(readServers(globalPath)).toEqual({});
  });

  it('upsert adds an entry and preserves every other key', () => {
    const { mcp, globalPath } = fixture();
    writeJson(globalPath, {
      default_agent: 'plan',
      provider: { llm: { models: {} } },
      mcp: { kept: { type: 'remote', url: 'https://kept' } },
      note: { deeply: { nested: [1, 2] } },
    });
    const before = readFileSync(globalPath, 'utf8');

    expect(
      mcp.upsert('added', { name: 'added', type: 'stdio', command: 'npx', args: ['x'] }, 'global'),
    ).toMatchObject({ ok: true });

    const after = readJson(globalPath);
    expect(after['default_agent']).toBe('plan');
    expect(after['provider']).toEqual({ llm: { models: {} } });
    expect(after['note']).toEqual({ deeply: { nested: [1, 2] } });
    expect(after.mcp?.['added']).toEqual({ type: 'local', command: ['npx', 'x'] });
    // The untouched entry survives verbatim, key order included.
    expect(readFileSync(globalPath, 'utf8').indexOf('"kept"')).toBe(before.indexOf('"kept"'));
  });

  it('refuses an invalid name or entry without writing', () => {
    const { mcp, globalPath } = fixture();
    writeJson(globalPath, { mcp: {} });

    const badName = mcp.save({ name: 'bad name!', type: 'stdio', command: 'x' }, 'global');
    expect(badName.ok).toBe(false);
    expect(badName.issues?.[0]).toMatchObject({ code: 'name', pointer: '/mcp/bad name!' });

    const badEntry = mcp.save({ name: 'bad', type: 'http' }, 'global');
    expect(badEntry.ok).toBe(false);
    expect(badEntry.issues?.[0]).toMatchObject({ code: 'shape', pointer: '/mcp/bad' });
    expect(badEntry.issues?.[0]?.message).toMatch(/needs a non-empty "url"/);

    expect(readServers(globalPath)).toEqual({});
  });

  it('replaces the managed set and removes every unlisted entry', () => {
    const { mcp, globalPath } = fixture();
    writeJson(globalPath, {
      theme: 'dark',
      mcp: {
        kept: { type: 'local', command: ['x'], timeout: 1 },
        dropped: { type: 'remote', url: 'https://dropped' },
      },
    });

    const replaced = mcp.replaceManaged(
      [{ name: 'kept', type: 'stdio', command: 'x', enabled: false }],
      'global',
    );

    expect(replaced).toMatchObject({ ok: true });
    expect(readJson(globalPath)).toEqual({
      theme: 'dark',
      mcp: { kept: { type: 'local', command: ['x'], timeout: 1, enabled: false } },
    });
  });

  it('signs the chain so a change or a touch moves the signature', () => {
    const { mcp, cwd, globalPath } = fixture();
    writeJson(globalPath, { mcp: { one: { type: 'local', command: ['x'] } } });

    const first = mcp.signature(cwd);
    expect(mcp.signature(cwd)).toBe(first);
    mcp.setEnabled('one', false, 'global');
    expect(mcp.signature(cwd)).not.toBe(first);

    const second = mcp.signature(cwd);
    const later = new Date(Date.now() + 10_000);
    utimesSync(globalPath, later, later);
    expect(mcp.signature(cwd)).not.toBe(second);
  });
});

describe('OpenCodeMcpStore', () => {
  it('reads and writes an injected config dir, jsonc included', () => {
    const base = root();
    const configDir = join(base, 'custom', 'opencode');
    const jsoncPath = join(configDir, 'opencode.jsonc');
    writeText(
      jsoncPath,
      '{\n  "mcp": { "one": { "type": "local", "command": ["x"] } } // trailing\n}\n',
    );
    const instance = new OpenCodeEngineDefinition({ configDir }).create(
      resolveEngineContext({
        ownership: 'user',
        home: join(base, 'home'),
        cwd: join(base, 'repo'),
        env: {},
      }),
    );

    const listed = instance.mcp.list(join(base, 'repo'));
    expect(listed.items.map((item) => item.server.name)).toEqual(['one']);
    expect(listed.items[0]!.source).toBe(jsoncPath);

    expect(instance.mcp.normalize('global')).toMatchObject({ ok: true, path: jsoncPath });
    expect(instance.mcp.setEnabled('one', false, 'global')).toMatchObject({
      ok: true,
      path: jsoncPath,
    });
    expect(readServers(jsoncPath).one).toEqual({
      type: 'local',
      command: ['x'],
      enabled: false,
    });
  });

  it('writes an isolated bot tree its own file with the isolated ownership', () => {
    const base = root();
    const bot = engine.create(
      resolveEngineContext({
        ownership: 'isolated',
        root: join(base, 'bots', 'x', 'config'),
        home: join(base, 'home'),
        env: {},
      }),
    );

    expect(bot.mcp.save({ name: 'one', type: 'stdio', command: 'npx' }, 'global')).toMatchObject({
      ok: true,
      path: join(base, 'bots', 'x', 'config', 'opencode', 'opencode.json'),
    });
    expect(bot.mcp.list()).toMatchObject({ issues: [] });
    expect(bot.mcp.list().items.map((item) => item.server.name)).toEqual(['one']);
  });
});
