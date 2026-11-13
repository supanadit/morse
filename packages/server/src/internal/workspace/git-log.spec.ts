import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGitLog } from './git-log';

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
  it('keeps every branch when no ref is named', async () => {
    const log = await readGitLog(root);
    expect(log.commits.map((c) => c.subject)).toEqual(
      expect.arrayContaining(['init', 'feat one', 'main two']),
    );
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
