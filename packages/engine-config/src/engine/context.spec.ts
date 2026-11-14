import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigScope } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigResourceStore } from '../core/config-store.js';
import { JsonConfigFile } from '../core/config-file.js';
import { NamedConfigSection } from '../core/section.js';
import type { ConfigPaths } from '../core/types.js';
import { resolveEngineContext } from './context.js';
import { UnsupportedScopeError, type ConfigLocator } from './locator.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-context-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Label = { name: string; label: string };

class LabelSection extends NamedConfigSection<Label> {
  readonly key = 'items';
  decodeEntry(name: string, raw: unknown): Label | undefined {
    const row = raw as { label?: unknown };
    return typeof row?.label === 'string' ? { name, label: row.label } : undefined;
  }
  encodeEntry(item: Label, kept: unknown): unknown {
    return { ...(kept as object), label: item.label };
  }
}

class LabelStore extends ConfigResourceStore<Label> {
  readonly section = new LabelSection();

  constructor(locator: ConfigLocator) {
    super(locator, 'items');
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
    return new JsonConfigFile(
      scope === 'project' ? this.projectPath : this.globalPath,
      fileId,
      scope,
    );
  }

  fileAt(fileId: string, path: string, scope: ConfigScope): JsonConfigFile {
    return new JsonConfigFile(path, fileId, scope);
  }

  scopeOf(_fileId: string, path: string): ConfigScope {
    return path === this.projectPath ? 'project' : 'global';
  }
}

class IsolatedLocator implements ConfigLocator {
  readonly ownership = 'isolated' as const;

  constructor(
    readonly globalPath: string,
    readonly projectPath: string,
  ) {}

  paths(fileId: string, scope: ConfigScope, _cwd?: string): ConfigPaths {
    if (scope === 'project') {
      throw new UnsupportedScopeError(fileId, scope, this.projectPath);
    }
    return { write: this.globalPath, read: [this.globalPath] };
  }

  file(fileId: string, scope: ConfigScope, _cwd?: string): JsonConfigFile {
    if (scope === 'project') {
      throw new UnsupportedScopeError(fileId, scope, this.projectPath);
    }
    return new JsonConfigFile(this.globalPath, fileId, scope);
  }

  fileAt(fileId: string, path: string, scope: ConfigScope): JsonConfigFile {
    if (scope === 'project') {
      throw new UnsupportedScopeError(fileId, scope, this.projectPath);
    }
    return new JsonConfigFile(path, fileId, scope);
  }

  scopeOf(_fileId: string, _path: string): ConfigScope {
    return 'global';
  }
}

function fixture(): { locator: FakeLocator; globalPath: string; projectPath: string } {
  const dir = root();
  const globalPath = join(dir, 'global', 'config.json');
  const projectPath = join(dir, 'project', 'config.json');
  for (const [path, value] of [
    [globalPath, { items: { b: { label: 'global-b' } } }],
    [projectPath, { items: { a: { label: 'project-a' } } }],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  return { locator: new FakeLocator(globalPath, projectPath), globalPath, projectPath };
}

describe('ConfigResourceStore precedence and paths', () => {
  it('lists project entries before global ones through the locator', () => {
    const { locator } = fixture();
    const store = new LabelStore(locator);

    expect(store.list().items).toEqual([
      { name: 'a', label: 'project-a' },
      { name: 'b', label: 'global-b' },
    ]);
  });

  it('resolves read precedence and the write target for each scope', () => {
    const { locator, globalPath, projectPath } = fixture();
    const store = new LabelStore(locator);

    expect(store.paths('project', '/work/app')).toEqual({
      read: [projectPath, globalPath],
      write: projectPath,
    });
    expect(store.paths('global', '/work/app')).toEqual({
      read: [globalPath],
      write: globalPath,
    });
  });

  it('takes a plain ConfigLocator, not an engine instance', () => {
    const { globalPath, projectPath } = fixture();
    const locator: ConfigLocator = {
      ownership: 'user',
      paths: (_fileId, scope) => ({
        write: scope === 'project' ? projectPath : globalPath,
        read: scope === 'project' ? [projectPath, globalPath] : [globalPath],
      }),
      file: (fileId, scope) =>
        new JsonConfigFile(scope === 'project' ? projectPath : globalPath, fileId, scope),
      fileAt: (fileId, path, scope) => new JsonConfigFile(path, fileId, scope),
      scopeOf: (_fileId, path) => (path === projectPath ? 'project' : 'global'),
    };

    expect(new LabelStore(locator).list().items.map((item) => item.name)).toEqual(['a', 'b']);
  });

  it('turns a rejected isolated project scope into an unsupported issue', () => {
    const dir = root();
    const globalPath = join(dir, 'config.json');
    const projectPath = join(dir, 'project.json');
    writeFileSync(globalPath, `${JSON.stringify({ items: { g: { label: 'g' } } }, null, 2)}\n`);
    const store = new LabelStore(new IsolatedLocator(globalPath, projectPath));

    expect(store.list().items).toEqual([{ name: 'g', label: 'g' }]);

    const refused = store.upsert('p', { name: 'p', label: 'p' }, 'project');
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({
      code: 'unsupported',
      scope: 'project',
      file: projectPath,
    });
    expect(store.list().items).toEqual([{ name: 'g', label: 'g' }]);
  });
});

describe('resolveEngineContext', () => {
  it('resolves the XDG defaults from home and an empty environment', () => {
    const context = resolveEngineContext({
      ownership: 'user',
      home: '/home/me',
      cwd: '/work/app',
      env: {},
    });

    expect(context).toEqual({
      ownership: 'user',
      home: '/home/me',
      cwd: '/work/app',
      env: {},
      xdgConfigHome: '/home/me/.config',
      xdgDataHome: '/home/me/.local/share',
    });
  });

  it('honours XDG variables and defaults home to the platform home', () => {
    const context = resolveEngineContext({
      env: { XDG_CONFIG_HOME: '/x/conf', XDG_DATA_HOME: '/x/data' },
    });

    expect(context.ownership).toBe('user');
    expect(context.home).toBe(homedir());
    expect(context.xdgConfigHome).toBe('/x/conf');
    expect(context.xdgDataHome).toBe('/x/data');
  });

  it('carries the root of an isolated context', () => {
    const context = resolveEngineContext({
      ownership: 'isolated',
      root: '/bots/x/config',
      home: '/home/me',
      env: {},
    });

    expect(context.ownership).toBe('isolated');
    expect(context.root).toBe('/bots/x/config');
    expect(context.xdgConfigHome).toBe('/home/me/.config');
  });
});
