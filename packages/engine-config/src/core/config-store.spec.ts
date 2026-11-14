import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigScope } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConfigLocator } from '../engine/locator.js';
import { JsonConfigFile } from './config-file.js';
import { ConfigResourceStore, ConfigStore } from './config-store.js';
import { ConfigSection, NamedConfigSection, type NamedConfigEntry } from './section.js';
import type { ConfigPaths, SectionContext } from './types.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-store-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeSection extends NamedConfigSection<{ label: string }> {
  readonly key = 'items';
  decodeEntry(name: string, raw: unknown): { label: string } | undefined {
    const row = raw as { label?: unknown };
    return typeof row?.label === 'string' ? { label: row.label } : undefined;
  }
  encodeEntry(item: { label: string }, kept: unknown): unknown {
    return { ...(kept as object), label: item.label };
  }
  keepsOnReplace(raw: unknown): boolean {
    return (raw as { keep?: boolean })?.keep === true;
  }
}

type FakeItem = { name: string; item: { label: string } };

class FakeStore extends ConfigResourceStore<{ label: string }, FakeItem> {
  readonly section = new FakeSection();

  constructor(locator: ConfigLocator) {
    super(locator, 'fake');
  }

  protected override toItem(entry: NamedConfigEntry<{ label: string }>): FakeItem {
    return entry;
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
  for (const [path, value] of [
    [globalPath, global],
    [projectPath, project],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  const locator = new FakeLocator(globalPath, projectPath);
  return { store: new FakeStore(locator), locator, globalPath, projectPath };
}

describe('ConfigResourceStore', () => {
  it('merges project over global by name and keeps a malformed sibling', () => {
    const { store, projectPath } = setup(
      { items: { a: { label: 'global-a' }, b: { label: 'global-b' } } },
      { items: { a: { label: 'project-a' }, bad: 3 } },
    );

    const listed = store.list();

    expect(listed.items).toEqual([
      { name: 'a', item: { label: 'project-a' } },
      { name: 'b', item: { label: 'global-b' } },
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

    const added = store.upsert('c', { label: 'c' }, 'project');
    expect(added.ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
      items: { c: { label: 'c' } },
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

    const replaced = store.replaceManaged([{ name: 'new', item: { label: 'new' } }], 'project');

    expect(replaced.ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
      items: {
        new: { label: 'new' },
        overridden: { label: 'over', keep: true },
      },
    });
  });

  it('apply is pure and returns the next document value', () => {
    const { store, projectPath } = setup({}, { items: { old: { label: 'old' } } });
    const before = readFileSync(projectPath, 'utf8');

    const result = store.apply(store.file().read(), [{ name: 'new', item: { label: 'new' } }]);

    expect(result.value).toMatchObject({ items: { new: { label: 'new' } } });
    expect(readFileSync(projectPath, 'utf8')).toBe(before);
  });

  it('refuses a JSONC target until it is normalized, then upserts', () => {
    const { store, projectPath } = setup({}, {});
    writeFileSync(projectPath, '{\n  // keep?\n  "items": {}\n}\n');

    const refused = store.upsert('c', { label: 'c' }, 'project');
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'normalize', fixable: true });
    expect(readFileSync(projectPath, 'utf8')).toContain('// keep?');

    expect(store.normalize('project')).toMatchObject({ ok: true, issues: [] });
    expect(store.upsert('c', { label: 'c' }, 'project').ok).toBe(true);
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
      items: { c: { label: 'c' } },
    });
  });
});

describe('ConfigStore', () => {
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
});
