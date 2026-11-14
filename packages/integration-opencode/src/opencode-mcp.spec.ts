import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenCodeMcp } from './opencode-mcp.js';

describe('OpenCodeMcp', () => {
  let dir: string;
  let mcp: OpenCodeMcp;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opencode-mcp-admin-'));
    cwd = join(dir, 'project');
    mkdirSync(cwd, { recursive: true });
    mcp = new OpenCodeMcp({ configDir: join(dir, 'config') });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const globalPath = (): string => join(dir, 'config', 'opencode.json');
  const projectPath = (): string => join(cwd, 'opencode.json');
  const projectJsoncPath = (): string => join(cwd, '.opencode', 'opencode.jsonc');

  const writeGlobal = (file: object): void => {
    mkdirSync(join(globalPath(), '..'), { recursive: true });
    writeFileSync(globalPath(), `${JSON.stringify(file, null, 2)}\n`);
  };

  /** A comment-bearing, trailing-comma file: readable, but not writable yet. */
  const writeJsonc = (path: string): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      [
        '{',
        '  // a hand-written note',
        '  "mcp": {',
        '    "one": { "type": "local", "command": ["npx", "one"], },',
        '  },',
        '}',
        '',
      ].join('\n'),
    );
  };

  describe('status', () => {
    it('reports servers from both scopes, honest about configured state', () => {
      writeGlobal({
        mcp: {
          one: { type: 'local', command: ['npx', 'one'] },
          off: { type: 'remote', url: 'https://off', enabled: false },
        },
      });
      const status = mcp.status(cwd);
      expect(status.trusted).toBe(true);
      expect(status.errors).toEqual([]);
      expect(status.servers).toHaveLength(2);
      const one = status.servers.find((s) => s.name === 'one')!;
      expect(one).toMatchObject({
        scope: 'global',
        enabled: true,
        transport: 'stdio: npx one',
        state: 'disconnected',
      });
      expect(one.tools).toEqual([]);
      const off = status.servers.find((s) => s.name === 'off')!;
      expect(off).toMatchObject({ enabled: false, state: 'disabled', scope: 'global' });
      expect(off.transport).toBe('http: https://off');
      expect(status.note).toMatch(/configured state only/);
    });

    it('a project entry wins and reports project scope', () => {
      writeGlobal({ mcp: { one: { type: 'local', command: ['global'] } } });
      writeFileSync(projectPath(), `${JSON.stringify({ mcp: { one: { type: 'local', command: ['project'] } } }, null, 2)}\n`);
      const status = mcp.status(cwd);
      expect(status.servers).toHaveLength(1);
      expect(status.servers[0]).toMatchObject({
        scope: 'project',
        source: projectPath(),
        transport: 'stdio: project',
      });
    });

    it('a malformed file becomes an error naming the path', () => {
      writeGlobal({ mcp: { broken: { type: 'local' } } });
      const status = mcp.status(cwd);
      expect(status.servers).toEqual([]);
      expect(status.errors[0]).toMatch(/local MCP server "broken"/);
    });

    it('without a directory lists the global file alone', () => {
      writeGlobal({ mcp: { one: { type: 'local', command: ['npx', 'one'] } } });
      writeFileSync(
        projectPath(),
        `${JSON.stringify({ mcp: { two: { type: 'local', command: ['two'] } } }, null, 2)}\n`,
      );
      // The empty-session view has no project: the user's own servers only.
      expect(mcp.status().servers.map((s) => s.name)).toEqual(['one']);
    });

    it('reads a JSONC config and reports a fixable issue', () => {
      writeJsonc(globalPath());
      const status = mcp.status(cwd);
      expect(status.servers.map((s) => s.name)).toEqual(['one']);
      expect(status.issues?.[0]).toMatchObject({ code: 'normalize', fixable: true });
    });
  });

  describe('mutations', () => {
    it('add writes a local server to the project file at project scope', () => {
      const result = mcp.add(
        { name: 'one', scope: 'project', command: 'npx', args: ['-y', 'one'], env: { A: '1' } },
        cwd,
      );
      expect(result).toMatchObject({ ok: true, scope: 'project', path: projectPath() });
      const file = JSON.parse(readFileSync(projectPath(), 'utf8')) as {
        mcp: Record<string, { type: string; command: string[]; environment?: Record<string, string> }>;
      };
      expect(file.mcp['one']).toMatchObject({
        type: 'local',
        command: ['npx', '-y', 'one'],
        environment: { A: '1' },
      });
    });

    it('add writes a remote server and refuses an incomplete one', () => {
      const ok = mcp.add({ name: 'r', url: 'https://x', headers: { h: '1' } }, cwd);
      expect(ok.ok).toBe(true);
      const file = JSON.parse(readFileSync(globalPath(), 'utf8')) as {
        mcp: Record<string, { type: string; url?: string; headers?: Record<string, string> }>;
      };
      expect(file.mcp['r']).toMatchObject({ type: 'remote', url: 'https://x', headers: { h: '1' } });

      const bad = mcp.add({ name: 'nope' }, cwd);
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/needs a "command"/);
    });

    it('remove refuses a name the scope does not define', () => {
      writeGlobal({ mcp: { one: { type: 'local', command: ['x'] } } });
      expect(mcp.remove('one', cwd, 'project')).toMatchObject({
        ok: false,
        message: expect.stringMatching(/project's opencode\.json/),
      });
      expect(mcp.remove('one', cwd, 'global')).toMatchObject({ ok: true, path: globalPath() });
    });

    it('setEnabled without a scope edits the defining file', () => {
      writeGlobal({ mcp: { one: { type: 'local', command: ['x'] } } });
      writeFileSync(projectPath(), `${JSON.stringify({ mcp: { two: { type: 'local', command: ['y'] } } }, null, 2)}\n`);
      expect(mcp.setEnabled('one', false, cwd)).toMatchObject({ ok: true, path: globalPath() });
      expect(mcp.setEnabled('two', false, cwd)).toMatchObject({ ok: true, path: projectPath() });
      expect(mcp.setEnabled('three', false, cwd)).toMatchObject({
        ok: false,
        message: expect.stringMatching(/No server named "three"/),
      });
    });

    it('refuses a mutation on JSONC until fixed, then writes', () => {
      writeJsonc(globalPath());
      const refused = mcp.add({ name: 'two', command: 'npx', args: ['two'] }, cwd);
      expect(refused.ok).toBe(false);
      expect(refused.issues?.[0]).toMatchObject({ code: 'normalize', fixable: true });
      // The file is untouched: a refused write never drops the reader's comments.
      expect(readFileSync(globalPath(), 'utf8')).toContain('// a hand-written note');

      expect(mcp.fix('global', cwd)).toMatchObject({ ok: true, path: globalPath() });
      expect(() => JSON.parse(readFileSync(globalPath(), 'utf8'))).not.toThrow();
      expect(mcp.add({ name: 'two', command: 'npx', args: ['two'] }, cwd)).toMatchObject({
        ok: true,
        path: globalPath(),
      });
      expect(mcp.status(cwd).servers.map((s) => s.name).sort()).toEqual(['one', 'two']);
    });

    it('refuses a project write to a jsonc project file until fixed', () => {
      writeJsonc(projectJsoncPath());
      const refused = mcp.add({ name: 'one', scope: 'project', command: 'npx' }, cwd);
      expect(refused).toMatchObject({ ok: false, path: projectJsoncPath() });
      expect(refused.issues?.[0]).toMatchObject({ code: 'normalize', fixable: true });

      expect(mcp.fix('project', cwd)).toMatchObject({ ok: true, path: projectJsoncPath() });
      expect(() => JSON.parse(readFileSync(projectJsoncPath(), 'utf8'))).not.toThrow();
      expect(mcp.add({ name: 'one', scope: 'project', command: 'npx' }, cwd)).toMatchObject({
        ok: true,
        path: projectJsoncPath(),
      });
    });

    it('trustProject succeeds without writing anything', async () => {
      expect(mcp.trustProject(cwd)).toEqual({ ok: true });
      expect(await mcp.configSignature(cwd)).toBe(await mcp.configSignature(cwd));
    });
  });
});
