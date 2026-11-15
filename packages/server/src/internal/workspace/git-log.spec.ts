import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitGit, readGitLog, readGitStatus } from './git-log';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morse-log-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  commit('init');
  git(root, 'checkout', '-q', '-b', 'feat');
  commit('feat one');
  git(root, 'checkout', '-q', 'main');
  commit('main two');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(subject: string): void {
  appendFileSync(join(root, 'file.txt'), `${subject}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', subject);
}

describe('readGitLog ref', () => {
  it('keeps the current branch when no ref is named', async () => {
    const log = await readGitLog(root);
    expect(log.commits.map((c) => c.subject)).toEqual(['main two', 'init']);
    expect(log.commits.map((c) => c.subject)).not.toContain('feat one');
  });

  it('returns only the named ref history', async () => {
    const log = await readGitLog(root, 50, 0, undefined, 'feat');
    expect(log.commits.map((c) => c.subject)).toEqual(['feat one', 'init']);
  });

  it('refuses an option-shaped ref', async () => {
    await expect(readGitLog(root, 50, 0, undefined, '--all')).rejects.toThrow(
      /usable git ref/,
    );
  });
});

describe('commitGit amend', () => {
  it('rewrites the last commit and keeps the count', async () => {
    writeFileSync(join(root, 'next.txt'), 'next');
    git(root, 'add', '.');

    const result = await commitGit(root, 'main two amended', undefined, true);

    expect(result.ok).toBe(true);
    expect(git(root, 'log', '-1', '--pretty=%s').trim()).toBe('main two amended');
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('keeps the old message when amend is given no message', async () => {
    const result = await commitGit(root, '   ', undefined, true);

    expect(result.ok).toBe(true);
    expect(git(root, 'log', '-1', '--pretty=%s').trim()).toBe('main two');
  });

  it('still refuses an empty message without amend', async () => {
    expect(await commitGit(root, '   ')).toMatchObject({ ok: false });
  });
});

/**
 * The polled status is how a browser frontend notices that another git client —
 * `lazygit` in a second terminal — moved a branch, since none of it touches the
 * working tree. `refs` is the fingerprint that moves; `branch` names HEAD.
 */
describe('readGitStatus refs', () => {
  it('carries the checked-out branch and a refs fingerprint', async () => {
    const status = await readGitStatus(root);

    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.refs).toMatch(/^[0-9a-f]{12}$/);
  });

  it('reads a quiet repository to the same fingerprint every time', async () => {
    const first = await readGitStatus(root);
    const second = await readGitStatus(root);

    expect(second.refs).toBe(first.refs);
    expect(second.branch).toBe(first.branch);
  });

  it('moves the fingerprint when another client adds a branch', async () => {
    const before = await readGitStatus(root);
    git(root, 'branch', 'from-elsewhere');
    const after = await readGitStatus(root);

    expect(after.refs).toBeDefined();
    expect(after.refs).not.toBe(before.refs);
    expect(after.branch).toBe('main');
  });

  it('moves the fingerprint on a checkout, keeping the same empty tree', async () => {
    const before = await readGitStatus(root);
    git(root, 'checkout', '-q', 'feat');
    const after = await readGitStatus(root);

    expect(after.branch).toBe('feat');
    expect(after.refs).not.toBe(before.refs);
    // Nothing in the working tree moved: the status alone could not have told.
    expect(after.files).toEqual(before.files);
  });

  it('reports no branch when HEAD is detached', async () => {
    git(root, 'checkout', '-q', '--detach', 'HEAD');

    expect((await readGitStatus(root)).branch).toBeUndefined();
  });
});
