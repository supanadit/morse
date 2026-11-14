import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigScope } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConfigLocator } from '../engine/locator.js';
import { JsonConfigFile } from './config-file.js';
import { ConfigResourceStore, ConfigStore } from './config-store.js';
import { ConfigSection, NamedConfigSection } from './section.js';
import type { ConfigPaths, SectionContext } from './types.js';

const roots: string[] = [];
/** Any non-empty directory: the fake locator resolves the same project file for every cwd. */
const CWD = '/work/app';

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-store-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Label = { name: string; label: string };

class FakeSection extends NamedConfigSection<Label> {
  readonly key = 'items';
  decodeEntry(name: string, raw: unknown): Label | undefined {
    const row = raw as { label?: unknown };
    return typeof row?.label === 'string' ? { name, label: row.label } : undefined;
  }
  encodeEntry(item: Label, kept: unknown): unknown {
    return { ...(kept as object), name: item.name, label: item.label };
  }
  override keepsOnReplace(raw: unknown): boolean {
    return (raw as { keep?: boolean })?.keep === true;
  }
}

class FakeStore extends ConfigResourceStore<Label> {
  readonly section = new FakeSection();

  constructor(locator: ConfigLocator) {
    super(locator, 'fake');
  }
}

class FakeConfigSection extends ConfigSection<{ theme: string }> {
  readonly key = 'settings';

  decode(raw: unknown, context: SectionContext): { theme: string } {
    const row = raw as { settings?: { theme?: unknown } };
    const theme = row?.settings?.theme;
    if (typeof theme !== 'string') {
      context.issues.push({
        file: context.file,
        fileId: context.fileId,
        scope: context.scope,
        pointer: context.pointer('settings'),
        code: 'shape',
        message: `${context.file}: "settings.theme" must be a string.`,
        fixable: false,
      });
      return { theme: 'default' };
    }
    return { theme };
  }

  encode(value: { theme: string }, existing: unknown): unknown {
    return { ...(existing as object), settings: value };
  }
}

class FakeConfigStore extends ConfigStore<{ theme: string }> {
  readonly section = new FakeConfigSection();

  constructor(locator: ConfigLocator) {
    super(locator, 'config');
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

class ChainLocator implements ConfigLocator {
  readonly ownership = 'user' as const;

  constructor(
    readonly readPaths: string[],
    readonly writePath: string,
  ) {}

  paths(_fileId: string, _scope: ConfigScope, _cwd?: string): ConfigPaths {
    return { read: this.readPaths, write: this.writePath };
  }

  file(fileId: string, _scope: ConfigScope, _cwd?: string): JsonConfigFile {
    return new JsonConfigFile(this.writePath, fileId, this.scopeOf(fileId, this.writePath));
  }

  fileAt(fileId: string, path: string, scope: ConfigScope): JsonConfigFile {
    return new JsonConfigFile(path, fileId, scope);
  }

  scopeOf(_fileId: string, path: string): ConfigScope {
    return path === this.writePath ? 'project' : 'global';
  }
}

class ChainStore extends ConfigResourceStore<Label, Label & { source: string }> {
  readonly section = new FakeSection();

  constructor(locator: ConfigLocator) {
    super(locator, 'fake');
  }

  protected override toItem(item: Label, source: string): Label & { source: string } {
    return { ...item, source };
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function setup(
  global: unknown,
  project: unknown,
): {
  store: FakeStore;
  locator: FakeLocator;
  globalPath: string;
  projectPath: string;
} {
  const dir = root();
  const globalPath = join(dir, 'global', 'config.json');
  const projectPath = join(dir, 'project', 'config.json');
  writeJson(globalPath, global);
  writeJson(projectPath, project);
  const locator = new FakeLocator(globalPath, projectPath);
  return { store: new FakeStore(locator), locator, globalPath, projectPath };
}

describe('ConfigResourceStore', () => {
  it('lists only the global file when there is no session directory', () => {
    const { store } = setup(
      { items: { g: { label: 'global' } } },
      { items: { p: { label: 'project' } } },
    );

    expect(store.list()).toEqual({ items: [{ name: 'g', label: 'global' }], issues: [] });
    // An empty directory is the same empty-session view.
    expect(store.list('')).toEqual({ items: [{ name: 'g', label: 'global' }], issues: [] });
    expect(store.list(CWD).items).toEqual([
      { name: 'p', label: 'project' },
      { name: 'g', label: 'global' },
    ]);
  });

  it('merges project over global by name and keeps a malformed sibling', () => {
    const { store, projectPath } = setup(
      { items: { a: { label: 'global-a' }, b: { label: 'global-b' } } },
      { items: { a: { label: 'project-a' }, bad: 3 } },
    );

    const listed = store.list(CWD);

    expect(listed.items).toEqual([
      { name: 'a', label: 'project-a' },
      { name: 'b', label: 'global-b' },
    ]);
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({
      code: 'shape',
      pointer: '/items/bad',
      scope: 'project',
      file: projectPath,
    });
  });

  it('upserts into the named scope file and deletes an emptied block', () => {
    const { store, globalPath, projectPath } = setup({ items: { a: { label: 'global-a' } } }, {});

    const added = store.upsert('c', { name: 'c', label: 'c' }, 'project');
    expect(added.ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
      items: { c: { name: 'c', label: 'c' } },
    });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({
      items: { a: { label: 'global-a' } },
    });

    const removed = store.remove('c', 'project');
    expect(removed.ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({});
  });

  it('replaceManaged removes unlisted entries but keeps kept-on-replace entries', () => {
    const { store, projectPath } = setup(
      {},
      { items: { old: { label: 'old' }, overridden: { label: 'over', keep: true } } },
    );

    const replaced = store.replaceManaged([{ name: 'new', label: 'new' }], 'project');

    expect(replaced.ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
      items: {
        new: { name: 'new', label: 'new' },
        overridden: { label: 'over', keep: true },
      },
    });
  });

  it('apply is pure and returns the next document value', () => {
    const { store, projectPath } = setup({}, { items: { old: { label: 'old' } } });
    const before = readFileSync(projectPath, 'utf8');

    const result = store.apply(store.file('project').read(), [{ name: 'new', label: 'new' }]);

    expect(result.value).toMatchObject({ items: { new: { label: 'new' } } });
    expect(readFileSync(projectPath, 'utf8')).toBe(before);
  });

  it('refuses a JSONC target until it is normalized, then upserts', () => {
    const { store, projectPath } = setup({}, {});
    writeText(projectPath, '{\n  // keep?\n  "items": {}\n}\n');

    const refused = store.upsert('c', { name: 'c', label: 'c' }, 'project');
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'normalize', fixable: true });
    expect(readFileSync(projectPath, 'utf8')).toContain('// keep?');

    expect(store.normalize('project')).toMatchObject({ ok: true, issues: [] });
    expect(store.upsert('c', { name: 'c', label: 'c' }, 'project').ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
      items: { c: { name: 'c', label: 'c' } },
    });
  });

  it('lists the lower file when a higher-precedence file is corrupt', () => {
    const { store, projectPath } = setup({ items: { g: { label: 'global' } } }, {});
    writeText(projectPath, '{ not json');

    const listed = store.list(CWD);

    expect(listed.items).toEqual([{ name: 'g', label: 'global' }]);
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({
      code: 'parse',
      file: projectPath,
      scope: 'project',
    });
  });

  it('walks a three-file chain and finds an entry only the middle file defines', () => {
    const dir = root();
    const projectPath = join(dir, 'project', 'config.json');
    const middlePath = join(dir, 'ancestor', 'config.json');
    const globalPath = join(dir, 'global', 'config.json');
    writeJson(projectPath, { items: {} });
    writeJson(middlePath, { items: { mid: { label: 'middle' } } });
    writeJson(globalPath, { items: { g: { label: 'global' } } });
    const store = new ChainStore(
      new ChainLocator([projectPath, middlePath, globalPath], projectPath),
    );

    expect(store.list(CWD).items).toEqual([
      { name: 'mid', label: 'middle', source: middlePath },
      { name: 'g', label: 'global', source: globalPath },
    ]);
    expect(store.signature(CWD).split(',')).toHaveLength(3);
  });

  it('keeps listing the middle file when the first chain file is corrupt', () => {
    const dir = root();
    const projectPath = join(dir, 'project', 'config.json');
    const middlePath = join(dir, 'ancestor', 'config.json');
    const globalPath = join(dir, 'global', 'config.json');
    writeText(projectPath, '{ not json');
    writeJson(middlePath, { items: { mid: { label: 'middle' } } });
    writeJson(globalPath, { items: { g: { label: 'global' } } });
    const store = new ChainStore(
      new ChainLocator([projectPath, middlePath, globalPath], projectPath),
    );

    const listed = store.list(CWD);

    expect(listed.items.map((item) => item.name)).toEqual(['mid', 'g']);
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({
      code: 'parse',
      file: projectPath,
      scope: 'project',
    });
  });

  it('refuses to remove a global entry through the project scope', () => {
    const { store, globalPath, projectPath } = setup({ items: { g: { label: 'global' } } }, {});
    const before = readFileSync(globalPath, 'utf8');

    const refused = store.remove('g', 'project');

    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({
      code: 'unsupported',
      file: projectPath,
      scope: 'project',
    });
    expect(readFileSync(globalPath, 'utf8')).toBe(before);
    expect(store.list(CWD).items).toEqual([{ name: 'g', label: 'global' }]);
  });

  it('keeps unknown top-level keys through upsert, remove and replaceManaged', () => {
    const { store, projectPath } = setup(
      {},
      {
        $schema: 'https://example.test/schema',
        other: { keep: 1 },
        items: { old: { label: 'old' } },
      },
    );
    const read = (): Record<string, unknown> =>
      JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;

    expect(store.upsert('new', { name: 'new', label: 'new' }, 'project').ok).toBe(true);
    expect(read()).toMatchObject({ $schema: 'https://example.test/schema', other: { keep: 1 } });

    expect(store.remove('new', 'project').ok).toBe(true);
    expect(read()).toMatchObject({ $schema: 'https://example.test/schema', other: { keep: 1 } });

    expect(store.replaceManaged([{ name: 'next', label: 'next' }], 'project').ok).toBe(true);
    expect(read()).toMatchObject({
      $schema: 'https://example.test/schema',
      other: { keep: 1 },
      items: { next: { label: 'next' } },
    });
  });

  it('treats __proto__ as an entry name, not a prototype setter', () => {
    const { store, projectPath } = setup({}, {});

    expect(store.upsert('__proto__', { name: '__proto__', label: 'data' }, 'project').ok).toBe(
      true,
    );
    let items = (
      JSON.parse(readFileSync(projectPath, 'utf8')) as { items: Record<string, unknown> }
    ).items;
    expect(Object.hasOwn(items, '__proto__')).toBe(true);
    expect(items['__proto__']).toEqual({ name: '__proto__', label: 'data' });
    expect(Object.getPrototypeOf(items)).toBe(Object.prototype);
    expect(store.list(CWD).items).toEqual([{ name: '__proto__', label: 'data' }]);

    expect(store.replaceManaged([{ name: '__proto__', label: 'replaced' }], 'project').ok).toBe(
      true,
    );
    items = (JSON.parse(readFileSync(projectPath, 'utf8')) as { items: Record<string, unknown> })
      .items;
    expect(Object.hasOwn(items, '__proto__')).toBe(true);
    expect(items['__proto__']).toEqual({ name: '__proto__', label: 'replaced' });

    expect(store.remove('__proto__', 'project').ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({});
  });

  it('apply reports a shape issue and no value for a non-object document root', () => {
    const { store } = setup({}, []);

    const result = store.apply(store.file('project').read(), []);

    expect(result.value).toBeUndefined();
    expect(result.issues[0]).toMatchObject({
      code: 'shape',
      file: store.file('project').path,
      fixable: false,
    });
  });

  it('turns an unexpected locator failure into a write issue with the target path', () => {
    const { locator, projectPath } = setup({}, {});
    const broken = new FakeStore(new BrokenLocator(locator.globalPath, locator.projectPath));

    const result = broken.upsert('x', { name: 'x', label: 'x' }, 'project');

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'write', file: projectPath });
    expect(result.issues[0].message).toContain('EACCES');
  });
});

class BrokenLocator extends FakeLocator {
  override fileAt(): JsonConfigFile {
    throw new Error('EACCES: permission denied');
  }
}

describe('ConfigStore', () => {
  it('reads the global document when there is no session directory', () => {
    const { locator, globalPath, projectPath } = setup(
      { settings: { theme: 'dark' } },
      { settings: { theme: 'light' } },
    );
    const store = new FakeConfigStore(locator);

    expect(store.read()).toMatchObject({ path: globalPath, value: { theme: 'dark' }, issues: [] });
    expect(store.read(undefined, CWD)).toMatchObject({
      path: projectPath,
      value: { theme: 'light' },
    });
  });

  it('reads and saves the whole document section', () => {
    const { locator, globalPath } = setup({ settings: { theme: 'dark' }, other: 1 }, {});
    const store = new FakeConfigStore(locator);

    const read = store.read('global');
    expect(read.value).toEqual({ theme: 'dark' });
    expect(read.path).toBe(globalPath);
    expect(read.issues).toEqual([]);

    expect(store.save({ theme: 'light' }, 'global').ok).toBe(true);
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({
      settings: { theme: 'light' },
      other: 1,
    });
  });

  it('refuses to save a whole section over a non-object root', () => {
    const { locator, globalPath } = setup([], {});
    const store = new FakeConfigStore(locator);
    const before = readFileSync(globalPath, 'utf8');

    const saved = store.save({ theme: 'light' }, 'global');

    expect(saved.ok).toBe(false);
    expect(saved.issues[0]).toMatchObject({ code: 'shape', file: globalPath });
    expect(readFileSync(globalPath, 'utf8')).toBe(before);
  });
});
