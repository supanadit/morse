import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGitRepos, resolveRepoCwd } from './git-repos';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morse-repos-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs git in `cwd`, failing loudly when the fixture setup itself is wrong. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A committed repository at `dir`, so `rev-parse` has a HEAD to name. */
function initRepo(dir: string, branch = 'main'): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  execFileSync('touch', [join(dir, 'file.txt')]);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

/**
 * The repository discovery the git panel's multi-repo accordion is built on:
 * the session's own repository first, then any nested ones (a submodule-like
 * checkout), with the nested paths kept relative to the session directory.
 */
describe('readGitRepos', () => {
  it('reports the session repository first, then nested ones', async () => {
    initRepo(root);
    initRepo(join(root, 'packages', 'lib'), 'dev');

    const result = await readGitRepos(root);

    expect(result.isRepo).toBe(true);
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0]).toMatchObject({ path: '', current: true, branch: 'main' });
    expect(result.repos[1]).toMatchObject({
      path: 'packages/lib',
      current: false,
      branch: 'dev',
    });
  });

  it('lists nested repositories even when the session directory is not one', async () => {
    mkdirSync(root, { recursive: true });
    initRepo(join(root, 'inner'));

    const result = await readGitRepos(root);

    // The project itself is not a repository, but the one beneath it is.
    expect(result.isRepo).toBe(true);
    expect(result.repos.map((repo) => repo.path)).toEqual(['inner']);
  });

  it('answers no repository for a plain directory', async () => {
    mkdirSync(root, { recursive: true });

    expect(await readGitRepos(root)).toEqual({ isRepo: false, repos: [] });
  });
});

describe('resolveRepoCwd', () => {
  it('returns the session directory for the empty repository path', async () => {
    expect(await resolveRepoCwd('/x', undefined)).toBe('/x');
    expect(await resolveRepoCwd('/x', '')).toBe('/x');
  });

  it('resolves a nested repository to its root', async () => {
    initRepo(root);
    const nested = join(root, 'packages', 'lib');
    initRepo(nested);

    expect(await resolveRepoCwd(root, 'packages/lib')).toBe(nested);
  });

  it('refuses a path outside the session directory', async () => {
    expect(await resolveRepoCwd(root, '../elsewhere')).toBeUndefined();
  });

  it('answers undefined for a path that is not a repository', async () => {
    mkdirSync(join(root, 'plain'), { recursive: true });

    expect(await resolveRepoCwd(root, 'plain')).toBeUndefined();
  });
});
