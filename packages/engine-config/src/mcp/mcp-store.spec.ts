import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigMutation, ConfigScope, McpExposure, McpServer } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonConfigFile } from '../core/config-file.js';
import { isPlainObject } from '../core/section.js';
import type { ConfigPaths, SectionContext } from '../core/types.js';
import type { ConfigLocator } from '../engine/locator.js';
import { McpSection } from './mcp-section.js';
import { McpStore } from './mcp-store.js';
import { assertMcpServerName, isValidMcpServerName } from './names.js';

const roots: string[] = [];
/** Any non-empty directory: the fake locator resolves the same project file for every cwd. */
const CWD = '/work/app';

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-mcp-store-'));
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

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function readJson(path: string): { mcpServers?: Record<string, Raw>; [key: string]: unknown } {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers?: Record<string, Raw>;
    [key: string]: unknown;
  };
}

/**
 * The engine half of the MCP store: pi-style entries. A full entry names a
 * transport; an entry with none of `type`/`command`/`url` only overrides
 * `enabled`/`exposure` of a server defined in a lower-precedence file.
 */
class FakeMcpSection extends McpSection {
  readonly key = 'mcpServers';

  override isOverride(raw: unknown): boolean {
    return (
      isPlainObject(raw) &&
      raw.type === undefined &&
      raw.command === undefined &&
      raw.url === undefined
    );
  }

  override keepsOnReplace(raw: unknown): boolean {
    return this.isOverride(raw);
  }

  decodeEntry(name: string, raw: unknown, _context: SectionContext): McpServer | undefined {
    if (!isPlainObject(raw)) {
      return undefined;
    }
    if (this.isOverride(raw)) {
      const server: McpServer = { name, type: 'stdio' };
      if (typeof raw.enabled === 'boolean') server.enabled = raw.enabled;
      if (typeof raw.exposure === 'string') server.exposure = raw.exposure as McpExposure;
      return server;
    }
    const type = raw.type === 'http' ? 'http' : raw.type === 'stdio' ? 'stdio' : undefined;
    if (type === undefined) {
      return undefined;
    }
    const server: McpServer = { name, type };
    if (typeof raw.command === 'string') server.command = raw.command;
    if (typeof raw.url === 'string') server.url = raw.url;
    if (typeof raw.enabled === 'boolean') server.enabled = raw.enabled;
    if (typeof raw.exposure === 'string') server.exposure = raw.exposure as McpExposure;
    return server;
  }

  encodeEntry(item: McpServer, kept: unknown): unknown {
    const encoded: Raw = { ...(isPlainObject(kept) ? kept : {}) };
    encoded.type = item.type;
    for (const key of ['command', 'url'] as const) {
      if (item[key] === undefined) {
        delete encoded[key];
      } else {
        encoded[key] = item[key];
      }
    }
    // Absent `enabled` means enabled, so `true` is never stored.
    if (item.enabled === false) {
      encoded.enabled = false;
    } else {
      delete encoded.enabled;
    }
    if (item.exposure === undefined) {
      delete encoded.exposure;
    } else {
      encoded.exposure = item.exposure;
    }
    return encoded;
  }
}

class FakeLocator implements ConfigLocator {
  readonly ownership = 'user' as const;

  constructor(
    readonly globalPath: string,
    readonly projectPath: string,
  ) {}

  paths(_fileId: string, scope: ConfigScope, _cwd?: string): ConfigPaths {
    return scope === 'project'
      ? { write: this.projectPath, read: [this.projectPath, this.globalPath] }
      : { write: this.globalPath, read: [this.globalPath] };
  }

  file(fileId: string, scope: ConfigScope, _cwd?: string): JsonConfigFile {
    return this.fileAt(fileId, scope === 'project' ? this.projectPath : this.globalPath, scope);
  }

  fileAt(fileId: string, path: string, scope: ConfigScope): JsonConfigFile {
    return new JsonConfigFile(path, fileId, scope);
  }

  scopeOf(_fileId: string, path: string): ConfigScope {
    return path === this.projectPath ? 'project' : 'global';
  }
}

class FakeMcpStore extends McpStore {
  constructor(locator: ConfigLocator) {
    super(locator, 'mcp', new FakeMcpSection());
  }
}

class OverrideMcpStore extends FakeMcpStore {
  readonly calls: Array<{ name: string; enabled: boolean; cwd: string }> = [];

  protected override writeProjectOverride(
    name: string,
    enabled: boolean,
    cwd: string,
  ): ConfigMutation | undefined {
    this.calls.push({ name, enabled, cwd });
    return { ok: true, path: join(cwd, '.pi', 'mcp.json'), scope: 'project', issues: [] };
  }
}

describe('MCP names', () => {
  it('refuses reserved and malformed names, and skips a malformed entry with a pointer', () => {
    expect(isValidMcpServerName('filesystem_1-x')).toBe(true);
    expect(isValidMcpServerName('__proto__')).toBe(false);
    expect(isValidMcpServerName('prototype')).toBe(false);
    expect(isValidMcpServerName('constructor')).toBe(false);
    expect(isValidMcpServerName('a/b')).toBe(false);
    expect(() => assertMcpServerName('a/b')).toThrow(
      '"a/b" is not a valid MCP server name (letters, digits, "_" and "-").',
    );
    expect(() => assertMcpServerName('filesystem')).not.toThrow();

    const globalFile = join(root(), 'mcp.json');
    writeFileSync(
      globalFile,
      `{
        "mcpServers": {
          "good": { "type": "stdio", "command": "ok" },
          "bad": 3,
          "a/b": { "type": "stdio", "command": "slash" },
          "x/y": 4,
          "__proto__": { "type": "stdio", "command": "proto" }
        }
      }\n`,
    );

    const store = new FakeMcpStore(new FakeLocator(globalFile, join(root(), '.pi', 'mcp.json')));
    const listed = store.list(CWD);

    expect(listed.items).toEqual([
      { server: { name: 'good', type: 'stdio', command: 'ok' }, scope: 'global', source: globalFile },
    ]);
    expect(listed.issues).toContainEqual(
      expect.objectContaining({
        code: 'shape',
        pointer: '/mcpServers/bad',
        file: globalFile,
        scope: 'global',
      }),
    );
    expect(listed.issues).toContainEqual(
      expect.objectContaining({
        code: 'name',
        pointer: '/mcpServers/a~1b',
        file: globalFile,
        scope: 'global',
      }),
    );
    expect(listed.issues).toContainEqual(
      expect.objectContaining({
        code: 'name',
        pointer: '/mcpServers/__proto__',
        file: globalFile,
        scope: 'global',
      }),
    );

    // An invalid name is refused before decoding, even when its value is not
    // an object: that entry reports `name`, not only `shape`.
    const invalidNameIssues = listed.issues.filter(
      (issue) => issue.pointer === '/mcpServers/x~1y',
    );
    expect(invalidNameIssues).toHaveLength(1);
    expect(invalidNameIssues[0]!.code).toBe('name');

    // A save validates the name before it touches the file.
    const refusedSave = store.upsert(
      'bad/name',
      { name: 'bad/name', type: 'stdio', command: 'x' },
      'global',
    );
    expect(refusedSave.ok).toBe(false);
    expect(refusedSave.issues).toContainEqual(
      expect.objectContaining({
        code: 'name',
        pointer: '/mcpServers/bad~1name',
        file: globalFile,
      }),
    );
  });
});

describe('McpStore', () => {
  it('lists project entries first and merges an override onto its base', () => {
    const projectFile = join(root(), '.pi', 'mcp.json');
    const globalFile = join(root(), 'agent', 'mcp.json');
    writeJson(globalFile, {
      mcpServers: {
        filesystem: { type: 'stdio', command: 'npx' },
        memory: { type: 'stdio', command: 'global-mem' },
      },
    });
    writeJson(projectFile, {
      mcpServers: {
        filesystem: { enabled: false, exposure: 'hidden' },
        memory: { type: 'stdio', command: 'project-mem' },
      },
    });

    const listed = new FakeMcpStore(new FakeLocator(globalFile, projectFile)).list(CWD);

    expect(listed.issues).toEqual([]);
    expect(listed.items).toEqual([
      {
        server: { name: 'memory', type: 'stdio', command: 'project-mem' },
        scope: 'project',
        source: projectFile,
      },
      {
        server: {
          name: 'filesystem',
          type: 'stdio',
          command: 'npx',
          enabled: false,
          exposure: 'hidden',
        },
        scope: 'global',
        source: globalFile,
        override: projectFile,
      },
    ]);
  });

  it('replaces the managed set, keeps override-only entries and unknown fields', () => {
    const globalFile = join(root(), 'mcp.json');
    writeJson(globalFile, {
      mcpServers: {
        old: { type: 'stdio', command: 'old', auth: { token: 't' } },
        keep: { type: 'stdio', command: 'keep', auth: { token: 'k' } },
        pin: { enabled: false },
      },
    });
    const store = new FakeMcpStore(new FakeLocator(globalFile, join(root(), '.pi', 'mcp.json')));

    const replaced = store.replaceManaged(
      [
        { name: 'new', type: 'stdio', command: 'npx' },
        { name: 'keep', type: 'stdio', command: 'keep', enabled: false },
      ],
      'global',
    );

    expect(replaced).toMatchObject({ ok: true, scope: 'global', path: globalFile });
    const next = readJson(globalFile).mcpServers!;
    expect(next.new).toEqual({ type: 'stdio', command: 'npx' });
    expect(next.keep).toEqual({
      type: 'stdio',
      command: 'keep',
      auth: { token: 'k' },
      enabled: false,
    });
    expect(next.pin).toEqual({ enabled: false });
    expect(next.old).toBeUndefined();
  });

  it('refuses an invalid name in a managed replacement before writing', () => {
    const globalFile = join(root(), 'mcp.json');
    const original = { mcpServers: { keep: { type: 'stdio', command: 'keep' } } };
    writeJson(globalFile, original);
    const store = new FakeMcpStore(new FakeLocator(globalFile, join(root(), '.pi', 'mcp.json')));

    const refused = store.replaceManaged(
      [
        { name: 'keep', type: 'stdio', command: 'keep' },
        { name: 'bad/name', type: 'stdio', command: 'x' },
        { name: '__proto__', type: 'stdio', command: 'p' },
      ],
      'global',
    );

    expect(refused.ok).toBe(false);
    expect(refused.issues).toHaveLength(2);
    expect(refused.issues).toContainEqual(
      expect.objectContaining({
        code: 'name',
        pointer: '/mcpServers/bad~1name',
        file: globalFile,
      }),
    );
    expect(refused.issues).toContainEqual(
      expect.objectContaining({
        code: 'name',
        pointer: '/mcpServers/__proto__',
        file: globalFile,
      }),
    );
    expect(readJson(globalFile)).toEqual(original);
  });

  it('deletes the block when the last entry is removed', () => {
    const globalFile = join(root(), 'mcp.json');
    writeJson(globalFile, {
      other: true,
      mcpServers: { only: { type: 'stdio', command: 'only' } },
    });
    const store = new FakeMcpStore(new FakeLocator(globalFile, join(root(), '.pi', 'mcp.json')));

    const removed = store.remove('only', 'global');

    expect(removed).toMatchObject({ ok: true, scope: 'global', path: globalFile });
    const next = readJson(globalFile);
    expect(next).toEqual({ other: true });
    expect(next).not.toHaveProperty('mcpServers');
  });

  it('writes a project override only for a user-level server the engine can pin', () => {
    const projectDir = root();
    const cwd = projectDir;
    const projectFile = join(projectDir, '.pi', 'mcp.json');
    const globalFile = join(root(), 'agent', 'mcp.json');
    writeJson(globalFile, {
      mcpServers: { x: { type: 'stdio', command: 'npx' } },
    });
    writeJson(projectFile, {
      mcpServers: { docs: { type: 'stdio', command: 'project-serve' } },
    });

    // A project-defined server is edited in place, even with a hook available.
    const hooked = new OverrideMcpStore(new FakeLocator(globalFile, projectFile));
    const inPlace = hooked.setEnabled('docs', false, 'project', cwd);

    expect(inPlace).toMatchObject({ ok: true, scope: 'project', path: projectFile });
    expect(hooked.calls).toEqual([]);
    expect(readJson(projectFile).mcpServers!.docs).toEqual({
      type: 'stdio',
      command: 'project-serve',
      enabled: false,
    });

    // An unknown name is refused before the hook can claim it.
    const unknown = hooked.setEnabled('ghost', false, 'project', cwd);
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('No server named "ghost"');
    expect(hooked.calls).toEqual([]);

    // A user-level server is pinned through the hook.
    const overridden = hooked.setEnabled('x', false, 'project', cwd);
    expect(overridden).toMatchObject({ ok: true, scope: 'project', path: projectFile });
    expect(hooked.calls).toEqual([{ name: 'x', enabled: false, cwd }]);

    // Without a hook the same edit is refused, and nothing is written.
    const plain = new FakeMcpStore(new FakeLocator(globalFile, projectFile));
    const refused = plain.setEnabled('x', false, 'project', cwd);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('project override');
    expect(refused.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsupported',
        pointer: '/mcpServers/x',
        file: globalFile,
        scope: 'project',
      }),
    );
    expect(readJson(globalFile).mcpServers!.x).toEqual({ type: 'stdio', command: 'npx' });
  });

  it('targets the global file for an explicit global edit and refuses a project-only server', () => {
    const projectDir = root();
    const cwd = projectDir;
    const projectFile = join(projectDir, '.pi', 'mcp.json');
    const globalFile = join(root(), 'agent', 'mcp.json');
    writeJson(globalFile, {
      mcpServers: { docs: { type: 'stdio', command: 'global-docs' } },
    });
    writeJson(projectFile, {
      mcpServers: { docs: { type: 'stdio', command: 'project-docs' } },
    });

    const store = new FakeMcpStore(new FakeLocator(globalFile, projectFile));
    const edited = store.setEnabled('docs', false, 'global', cwd);

    expect(edited).toMatchObject({ ok: true, scope: 'global', path: globalFile });
    expect(readJson(globalFile).mcpServers!.docs).toEqual({
      type: 'stdio',
      command: 'global-docs',
      enabled: false,
    });
    // The nearer project definition was not touched.
    expect(readJson(projectFile).mcpServers!.docs).toEqual({
      type: 'stdio',
      command: 'project-docs',
    });

    // A project-only server is not a global definition: refuse without writing.
    const projectOnlyFile = join(root(), '.pi', 'mcp.json');
    writeJson(projectOnlyFile, {
      mcpServers: { only: { type: 'stdio', command: 'serve' } },
    });
    const emptyGlobal = join(root(), 'agent', 'mcp.json');
    const alone = new FakeMcpStore(new FakeLocator(emptyGlobal, projectOnlyFile));
    const refused = alone.setEnabled('only', false, 'global', cwd);

    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('No server named "only"');
    expect(existsSync(emptyGlobal)).toBe(false);
    expect(readJson(projectOnlyFile).mcpServers!.only).toEqual({
      type: 'stdio',
      command: 'serve',
    });
  });

  it('edits the nearest definition when no scope is named', () => {
    const projectDir = root();
    const cwd = projectDir;
    const projectFile = join(projectDir, '.pi', 'mcp.json');
    const globalFile = join(root(), 'agent', 'mcp.json');
    writeJson(globalFile, {
      mcpServers: {
        shared: { type: 'stdio', command: 'global-shared' },
        onlyGlobal: { type: 'stdio', command: 'global-only' },
      },
    });
    writeJson(projectFile, {
      mcpServers: { shared: { type: 'stdio', command: 'project-shared' } },
    });
    const store = new FakeMcpStore(new FakeLocator(globalFile, projectFile));

    const projectEdit = store.setEnabled('shared', false, undefined, cwd);
    expect(projectEdit).toMatchObject({ ok: true, scope: 'project', path: projectFile });
    expect(readJson(projectFile).mcpServers!.shared).toEqual({
      type: 'stdio',
      command: 'project-shared',
      enabled: false,
    });
    expect(readJson(globalFile).mcpServers!.shared).toEqual({
      type: 'stdio',
      command: 'global-shared',
    });

    const globalEdit = store.setEnabled('onlyGlobal', false, undefined, cwd);
    expect(globalEdit).toMatchObject({ ok: true, scope: 'global', path: globalFile });
    expect(readJson(globalFile).mcpServers!.onlyGlobal).toEqual({
      type: 'stdio',
      command: 'global-only',
      enabled: false,
    });

    const missing = store.setEnabled('ghost', false, undefined, cwd);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('No server named "ghost"');

    // An unnamed scope never asks for an override, even with a hook.
    const hooked = new OverrideMcpStore(new FakeLocator(globalFile, projectFile));
    const enabled = hooked.setEnabled('shared', true, undefined, cwd);
    expect(enabled).toMatchObject({ ok: true, scope: 'project' });
    expect(hooked.calls).toEqual([]);
  });

  it('surfaces parse and shape issues instead of reporting an unknown server', () => {
    const projectDir = root();
    const cwd = projectDir;
    const projectFile = join(projectDir, '.pi', 'mcp.json');
    const globalFile = join(root(), 'agent', 'mcp.json');
    writeText(globalFile, '{ "mcpServers": { "x": ');
    const store = new FakeMcpStore(new FakeLocator(globalFile, projectFile));

    const corrupt = store.setEnabled('x', false, 'global', cwd);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.message).not.toContain('No server named');
    expect(corrupt.issues.map((issue) => issue.code)).toContain('parse');

    writeJson(globalFile, { mcpServers: { x: 4 } });
    const malformed = store.setEnabled('x', false, 'global', cwd);
    expect(malformed.ok).toBe(false);
    expect(malformed.message).not.toContain('No server named');
    expect(malformed.issues).toContainEqual(
      expect.objectContaining({
        code: 'shape',
        pointer: '/mcpServers/x',
        file: globalFile,
      }),
    );
  });
});
