import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configSignature,
  effectiveServers,
  openCodeConfigPaths,
  readMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from './opencode-mcp-config.js';

describe('opencode-mcp-config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opencode-mcp-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const globalPath = (): string => join(dir, 'global', 'opencode.json');
  const projectPath = (): string => join(dir, 'project', 'opencode.json');
  const paths = (): string[] => [projectPath(), globalPath()];

  const writeGlobal = (file: object): void => {
    const path = globalPath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  };

  describe('readMcpServers', () => {
    it('returns empty for a missing file', () => {
      expect(readMcpServers(globalPath())).toEqual({});
    });

    it('reads local and remote entries', () => {
      writeGlobal({
        mcp: {
          local_one: { type: 'local', command: ['npx', '-y', 'one'], enabled: false },
          remote_one: { type: 'remote', url: 'https://mcp.example.com' },
        },
      });
      const servers = readMcpServers(globalPath());
      expect(servers['local_one']).toMatchObject({ type: 'local', enabled: false });
      expect(servers['remote_one']).toMatchObject({ type: 'remote', url: 'https://mcp.example.com' });
    });

    it('throws naming the file when "mcp" is not an object', () => {
      writeGlobal({ mcp: ['nope'] });
      expect(() => readMcpServers(globalPath())).toThrow(/"mcp" must be an object/);
    });

    it('throws naming the server when an entry is malformed', () => {
      writeGlobal({ mcp: { broken: { type: 'local' } } });
      expect(() => readMcpServers(globalPath())).toThrow(/local MCP server "broken" needs/);
      writeGlobal({ mcp: { broken: { type: 'remote' } } });
      expect(() => readMcpServers(globalPath())).toThrow(/remote MCP server "broken" needs a "url"/);
    });
  });

  describe('effectiveServers', () => {
    it('lets the project entry replace a same-named global one', () => {
      writeGlobal({
        mcp: { shared: { type: 'local', command: ['global'] }, only_global: { type: 'local', command: ['g'] } },
      });
      mkdirSync(join(projectPath(), '..'), { recursive: true });
      writeFileSync(projectPath(), `${JSON.stringify({ mcp: { shared: { type: 'local', command: ['project'] } } }, null, 2)}\n`);
      const servers = effectiveServers(paths());
      const shared = servers.find((s) => s.name === 'shared');
      expect(shared?.server.command).toEqual(['project']);
      expect(shared?.source).toBe(projectPath());
      expect(servers.some((s) => s.name === 'only_global')).toBe(true);
    });
  });

  describe('mutations', () => {
    it('upsert adds an entry and preserves every other key', () => {
      writeGlobal({
        default_agent: 'plan',
        provider: { llm: { models: {} } },
        mcp: { kept: { type: 'remote', url: 'https://kept' } },
        note: { deeply: { nested: [1, 2] } },
      });
      const before = readFileSync(globalPath(), 'utf8');
      upsertMcpServer(globalPath(), 'added', { type: 'local', command: ['npx', 'x'] });
      const after = JSON.parse(readFileSync(globalPath(), 'utf8')) as Record<string, unknown>;
      expect(after['default_agent']).toBe('plan');
      expect(after['provider']).toEqual({ llm: { models: {} } });
      expect(after['note']).toEqual({ deeply: { nested: [1, 2] } });
      expect((after['mcp'] as Record<string, object>)['added']).toEqual({ type: 'local', command: ['npx', 'x'] });
      // The untouched entry survives verbatim, key order included.
      expect(readFileSync(globalPath(), 'utf8').indexOf('"kept"')).toBe(before.indexOf('"kept"'));
    });

    it('upsert refuses an invalid entry without writing', () => {
      writeGlobal({ mcp: {} });
      expect(() => upsertMcpServer(globalPath(), 'bad', { type: 'remote' })).toThrow(/needs a "url"/);
      expect(() => upsertMcpServer(globalPath(), 'bad name!', { type: 'local', command: ['x'] })).toThrow(
        /not a valid MCP server name/,
      );
      expect(JSON.parse(readFileSync(globalPath(), 'utf8'))).toEqual({ mcp: {} });
    });

    it('remove deletes one entry and reports absence', () => {
      writeGlobal({ mcp: { one: { type: 'local', command: ['x'] } } });
      expect(removeMcpServer(globalPath(), 'one')).toBe(true);
      expect(JSON.parse(readFileSync(globalPath(), 'utf8'))).toEqual({});
      expect(removeMcpServer(globalPath(), 'one')).toBe(false);
    });

    it('setEnabled toggles and drops enabled:true as the default', () => {
      writeGlobal({ mcp: { one: { type: 'local', command: ['x'], enabled: false }, two: { type: 'local', command: ['y'] } } });
      expect(setMcpServerEnabled(globalPath(), 'one', true)).toBe(true);
      expect(readMcpServers(globalPath())['one']).toEqual({ type: 'local', command: ['x'] });
      expect(setMcpServerEnabled(globalPath(), 'two', false)).toBe(true);
      expect(readMcpServers(globalPath())['two']).toMatchObject({ enabled: false });
      // Unknown fields on the entry survive the toggle.
      writeGlobal({ mcp: { one: { type: 'remote', url: 'https://x', oauth: { a: 1 } } } });
      setMcpServerEnabled(globalPath(), 'one', false);
      expect(readMcpServers(globalPath())['one']).toMatchObject({ oauth: { a: 1 }, enabled: false });
      expect(setMcpServerEnabled(globalPath(), 'missing', true)).toBe(false);
    });
  });

  describe('configSignature', () => {
    it('is stable for an unchanged file and moves on any change', () => {
      writeGlobal({ mcp: { one: { type: 'local', command: ['x'] } } });
      const first = configSignature(paths());
      expect(configSignature(paths())).toBe(first);
      setMcpServerEnabled(globalPath(), 'one', false);
      expect(configSignature(paths())).not.toBe(first);
    });

    it('moves when only mtime moves', () => {
      writeGlobal({ mcp: {} });
      const first = configSignature(paths());
      const later = new Date(Date.now() + 10_000);
      utimesSync(globalPath(), later, later);
      expect(configSignature(paths())).not.toBe(first);
    });
  });

  describe('openCodeConfigPaths', () => {
    it('puts the project file first and honours an injected config dir', () => {
      expect(openCodeConfigPaths('/w', dir)).toEqual([
        join('/w', 'opencode.json'),
        join(dir, 'opencode.json'),
      ]);
      expect(openCodeConfigPaths(undefined, dir)).toEqual([join(dir, 'opencode.json')]);
    });
  });
});
