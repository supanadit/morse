import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
          "__proto__": { "type": "stdio", "command": "proto" }
        }
      }\n`,
    );

    const store = new FakeMcpStore(new FakeLocator(globalFile, join(root(), '.pi', 'mcp.json')));
    const listed = store.list();

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

    const listed = new FakeMcpStore(new FakeLocator(globalFile, projectFile)).list();

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

  it('writes a project override only when the engine supports it', () => {
    const projectDir = root();
    const cwd = projectDir;
    const projectFile = join(projectDir, '.pi', 'mcp.json');
    const globalFile = join(root(), 'agent', 'mcp.json');
    writeJson(globalFile, {
      mcpServers: { x: { type: 'stdio', command: 'npx' } },
    });

    const hooked = new OverrideMcpStore(new FakeLocator(globalFile, projectFile));
    const overridden = hooked.setEnabled('x', false, 'project', cwd);

    expect(overridden).toMatchObject({ ok: true, scope: 'project', path: projectFile });
    expect(hooked.calls).toEqual([{ name: 'x', enabled: false, cwd }]);

    const plain = new FakeMcpStore(new FakeLocator(globalFile, projectFile));
    const refused = plain.setEnabled('x', false, 'project', cwd);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('project override');
    expect(refused.issues.map((issue) => issue.code)).toContain('unsupported');
    expect(refused.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsupported',
        pointer: '/mcpServers/x',
        file: globalFile,
        scope: 'project',
      }),
    );
    // The store without the hook did not touch the defining file.
    expect(readJson(globalFile).mcpServers!.x).toEqual({ type: 'stdio', command: 'npx' });

    // The global scope edits the defining entry in place.
    const global = plain.setEnabled('x', false, 'global', cwd);
    expect(global).toMatchObject({ ok: true, scope: 'global', path: globalFile });
    expect(readJson(globalFile).mcpServers!.x).toEqual({
      type: 'stdio',
      command: 'npx',
      enabled: false,
    });

    // A project-defined server is edited in place, without an override.
    writeJson(projectFile, { mcpServers: { y: { type: 'stdio', command: 'serve' } } });
    const inPlace = plain.setEnabled('y', false, 'project', cwd);
    expect(inPlace).toMatchObject({ ok: true, scope: 'project', path: projectFile });
    expect(readJson(projectFile).mcpServers!.y).toEqual({
      type: 'stdio',
      command: 'serve',
      enabled: false,
    });

    // An unknown server is refused with the usual message.
    const missing = plain.setEnabled('missing', false, 'global', cwd);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('No server named "missing"');
  });
});
