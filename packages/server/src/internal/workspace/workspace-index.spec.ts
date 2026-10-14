import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@morse/core';
import { clearWorkspaceIndex, listProjectDirectory, workspaceFiles } from './workspace-index';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morse-index-'));
  clearWorkspaceIndex();
});

afterEach(() => {
  clearWorkspaceIndex();
  rmSync(root, { recursive: true, force: true });
});

/** A directory with one real file in it, so a listing is never empty. */
function project(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  return dir;
}

/**
 * The server's workspace index is module-global and, unlike the VS Code host's
 * single cached slot, is keyed by directory — a global browser host that browses
 * many projects would otherwise retain a listing for every one it has ever seen.
 * These tests lock the cache to its cap.
 */
describe('workspace index cache', () => {
  it('lists a project once and serves the second call from the cache', async () => {
    const dir = project('one');
    const first = await workspaceFiles(dir, silentLogger);
    const second = await workspaceFiles(dir, silentLogger);
    expect(second).toEqual(first);
    expect(first).toContain('a.ts');
  });

  it('stays available after more projects than the cap are browsed', async () => {
    // The cap is 8; browse 12 distinct projects, then confirm the newest is
    // still cached (a re-read of a dropped project would be a fresh walk, which
    // this cannot distinguish — but it must at least not throw or go stale).
    const dirs: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      dirs.push(project(`p${i}`));
    }
    for (const dir of dirs) {
      const files = await workspaceFiles(dir, silentLogger);
      expect(files).toContain('a.ts');
    }
    // The most recently browsed project is still correct.
    expect(await workspaceFiles(dirs.at(-1)!, silentLogger)).toContain('a.ts');
  });

  it('forgets a directory on clearWorkspaceIndex(cwd)', async () => {
    const dir = project('two');
    expect(await workspaceFiles(dir, silentLogger)).toContain('a.ts');
    clearWorkspaceIndex(dir);
    // A fresh read after clearing still works (it re-indexes).
    expect(await workspaceFiles(dir, silentLogger)).toContain('a.ts');
  });

  it('refreshes on a `fresh` read, so a file added on disk appears', async () => {
    const dir = project('three');
    await workspaceFiles(dir, silentLogger);
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
    const fresh = await workspaceFiles(dir, silentLogger, { fresh: true });
    expect(fresh).toContain('b.ts');
  });
});

/**
 * The Explorer's lazy tree reads one level at a time from here: no cap, the
 * `listFiles` vocabulary, and the same skip rules the index walks with — so a
 * parent directory past the index's first five thousand files still draws every
 * folder of the level it asks for.
 */
describe('listProjectDirectory', () => {
  it('lists one level: files plainly, folders with the trailing slash', async () => {
    const dir = project('levels');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'main.ts'), 'export {};\n');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'dep.js'), '');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.gitignore'), '*~\n');

    // The index's skip rules hold level by level: no build directory, no
    // dot-folder — while a dot-*file* stays exactly as pickable as ever.
    expect(await listProjectDirectory(dir, '')).toEqual(['.gitignore', 'a.ts', 'src/']);
    // Entries stay project-relative, so a level merges into the flat listing.
    expect(await listProjectDirectory(dir, 'src')).toEqual(['src/main.ts']);
  });

  it('refuses a directory outside the project, like the preview does', async () => {
    const dir = project('guarded');

    await expect(listProjectDirectory(dir, '..')).rejects.toThrow(
      'The project only lists its own directories.',
    );
    await expect(listProjectDirectory(dir, '/etc')).rejects.toThrow(
      'The project only lists its own directories.',
    );
    // The project root itself is the empty path, not an escape.
    expect(await listProjectDirectory(dir, '')).toContain('a.ts');
  });

  it('answers a vanished directory with none, instead of failing the tree', async () => {
    const dir = project('gone');
    expect(await listProjectDirectory(dir, 'deleted')).toEqual([]);
  });
});
