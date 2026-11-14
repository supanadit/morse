import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigScope } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { FileResourceStore, type FileStoreOptions } from './file-store.js';
import type { ResourceDirs } from './resource-store.js';

type FakeItem = { name: string; scope: ConfigScope; body: string; error?: string };

type FakeSave = {
  name: string;
  originalName?: string;
  originalScope?: ConfigScope;
  body: string;
};

class FakeFileStore extends FileResourceStore<FakeItem, FakeSave> {
  readonly extension = 'md';

  constructor(
    private readonly roots: ResourceDirs,
    options?: FileStoreOptions,
  ) {
    super('fake', { ownership: 'user' }, options);
  }

  dirs(): ResourceDirs {
    return this.roots;
  }

  decode(name: string, raw: string, _path: string, scope: ConfigScope): FakeItem {
    if (raw.split('\n')[0] === 'BROKEN') {
      return { name, scope, body: '', error: 'bad frontmatter' };
    }
    return { name, scope, body: raw.trim() };
  }

  encode(input: FakeSave): string {
    return input.body;
  }
}

const roots: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-file-store-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileResourceStore', () => {
  it('lists both scopes and shadows global by name', () => {
    const globalDir = temp();
    const projectDir = temp();
    writeFileSync(join(globalDir, 'a.md'), 'global a');
    writeFileSync(join(globalDir, 'b.md'), 'global b');
    writeFileSync(join(projectDir, 'a.md'), 'project a');

    const listed = new FakeFileStore({ global: globalDir, project: projectDir }).list('/work');

    expect(listed.issues).toEqual([]);
    expect(listed.items).toEqual([
      { name: 'a', scope: 'project', body: 'project a' },
      { name: 'b', scope: 'global', body: 'global b' },
    ]);
  });

  it('keeps a broken file as an item with an error, not a list failure', () => {
    const globalDir = temp();
    writeFileSync(join(globalDir, 'broken.md'), 'BROKEN');
    writeFileSync(join(globalDir, 'fine.md'), 'fine');

    const listed = new FakeFileStore({ global: globalDir }).list();

    expect(listed.items).toEqual([
      { name: 'broken', scope: 'global', body: '', error: 'bad frontmatter' },
      { name: 'fine', scope: 'global', body: 'fine' },
    ]);
  });

  it('writes the new scope before deleting the old one on a move', () => {
    const globalDir = temp();
    const projectDir = temp();
    writeFileSync(join(globalDir, 'x.md'), 'old');
    const store = new FakeFileStore({ global: globalDir, project: projectDir });

    const moved = store.save(
      { name: 'x', originalName: 'x', originalScope: 'global', body: 'new' },
      'project',
      '/work',
    );

    expect(moved).toMatchObject({ ok: true, scope: 'project' });
    expect(readFileSync(join(projectDir, 'x.md'), 'utf8')).toBe('new');
    expect(existsSync(join(globalDir, 'x.md'))).toBe(false);

    // A rename inside one scope is the same rule: write the target, then drop the old file.
    store.save(
      { name: 'y', originalName: 'x', originalScope: 'project', body: 'renamed' },
      'project',
    );
    expect(readFileSync(join(projectDir, 'y.md'), 'utf8')).toBe('renamed');
    expect(existsSync(join(projectDir, 'x.md'))).toBe(false);
  });

  it('refuses a project save when there is no project directory', () => {
    const globalDir = temp();
    const store = new FakeFileStore({ global: globalDir });

    const refused = store.save({ name: 'x', body: 'new' }, 'project', '/work');

    expect(refused.ok).toBe(false);
    expect(refused.issues[0]?.code).toBe('unsupported');
    expect(existsSync(join(globalDir, 'x.md'))).toBe(false);

    // An engine that spells "no project" as '' must not fall back to the process cwd.
    const empty = new FakeFileStore({ global: globalDir, project: '' });
    const emptyRefusal = empty.save({ name: 'x', body: 'new' }, 'project', '/work');
    expect(emptyRefusal.ok).toBe(false);
    expect(emptyRefusal.issues[0]?.code).toBe('unsupported');
    expect(existsSync(join(globalDir, 'x.md'))).toBe(false);
  });

  it('writes through a symlinked prompt file instead of replacing the link', () => {
    const globalDir = temp();
    const dotfiles = temp();
    const target = join(dotfiles, 'x.md');
    writeFileSync(target, 'old prompt');
    chmodSync(target, 0o640);
    const link = join(globalDir, 'x.md');
    symlinkSync(target, link);
    const store = new FakeFileStore({ global: globalDir });

    const saved = store.save(
      { name: 'x', originalName: 'x', originalScope: 'global', body: 'new prompt' },
      'global',
    );

    expect(saved).toMatchObject({ ok: true });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new prompt');
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(readdirSync(globalDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dotfiles).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('turns a throwing decoder into a list issue instead of a failure', () => {
    const globalDir = temp();
    writeFileSync(join(globalDir, 'boom.md'), 'boom');
    writeFileSync(join(globalDir, 'fine.md'), 'fine');
    const store = new FakeFileStore({ global: globalDir });
    store.decode = () => {
      throw new Error('codec blew up');
    };

    const listed = store.list();

    expect(listed.items).toEqual([]);
    expect(listed.issues).toHaveLength(2);
    expect(listed.issues[0]?.code).toBe('shape');
    expect(listed.issues[0]?.file).toBe(join(globalDir, 'boom.md'));
  });

  it('keeps the old file when the new write fails', () => {
    const root = temp();
    const globalDir = join(root, 'global');
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'a regular file where the directory should be');
    const store = new FakeFileStore({ global: globalDir, project: blocked });
    store.save({ name: 'x', body: 'old' }, 'global');

    const failed = store.save(
      { name: 'x', originalName: 'x', originalScope: 'global', body: 'new' },
      'project',
    );

    expect(failed.ok).toBe(false);
    expect(failed.issues[0]?.code).toBe('write');
    expect(readFileSync(join(globalDir, 'x.md'), 'utf8')).toBe('old');
  });

  it('refuses a name that is not a safe file name', () => {
    const store = new FakeFileStore({ global: temp() });

    const refused = store.save({ name: '../escape', body: 'x' }, 'global');

    expect(refused.ok).toBe(false);
    expect(refused.issues[0]?.code).toBe('name');
  });
});
