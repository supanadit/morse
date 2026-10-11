import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Dirent } from 'node:fs';
import type { GitRepoInfo, GitRepos } from '@morse/protocol';
import { resolveWithin } from './file-store.js';

/**
 * How deep a project is scanned for nested repositories, and how many are kept.
 * A submodule usually sits one or two levels down; a monorepo of vendored
 * checkouts can go deeper, but the walk has to stop somewhere — past this the
 * repositories are not "under the project" in a way a panel can show.
 */
const MAX_DEPTH = 3;
const MAX_REPOS = 24;

/**
 * Directories the scan never descends into. Mirrors the file picker's skip list:
 * a dependency tree is not a set of repositories the reader owns, and walking it
 * would make the scan slow enough to feel broken.
 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  'vendor',
  'venv',
  '__pycache__',
  '.angular',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
]);

/**
 * The repositories a project holds: the one its directory sits in (if any) plus
 * every nested repository — a submodule, or a separate checkout placed under the
 * project tree. VS Code calls the same set its source-control repositories.
 *
 * The session directory's own repository is first and marked `current`; the rest
 * follow by path. A project that is not itself a repository but holds nested ones
 * still answers `isRepo: true` with those, so the panel can show them instead of
 * saying "no repository here".
 */
export async function readGitRepos(cwd: string): Promise<GitRepos> {
  const repos: GitRepoInfo[] = [];
  const seen = new Set<string>();

  const own = await gitText(['rev-parse', '--show-toplevel'], cwd);
  const ownRoot = own?.trim();
  if (ownRoot) {
    seen.add(ownRoot);
    repos.push({
      path: '',
      root: ownRoot,
      name: basename(ownRoot) || basename(cwd),
      current: true,
      branch: await branchOf(cwd),
    });
  }

  const nested: string[] = [];
  await walk(cwd, cwd, 0, nested);
  for (const root of nested) {
    if (repos.length >= MAX_REPOS) {
      break;
    }
    const absolute = resolveWithin(cwd, root);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    repos.push({
      path: toPosix(root),
      root: absolute,
      name: basename(absolute),
      current: false,
      branch: await branchOf(absolute),
    });
  }

  return { isRepo: repos.length > 0, repos };
}

/**
 * Resolves the repository a client named to its absolute working directory,
 * kept inside the viewing session's project. `''` (or absent) is the session
 * directory's own repository — what the panel sends for the first row. A named
 * sub-repository is a path below the session directory, so the same
 * `resolveWithin` guard that protects `readFile` applies, and the repository
 * root is then read from git itself rather than trusted from the client.
 * `undefined` means the named path is not a repository.
 */
export async function resolveRepoCwd(cwd: string, repo?: string): Promise<string | undefined> {
  if (repo === undefined || repo.length === 0) {
    return cwd;
  }
  let target: string;
  try {
    target = resolveWithin(cwd, repo);
  } catch {
    return undefined;
  }
  const root = await gitText(['rev-parse', '--show-toplevel'], target);
  return root?.trim() || undefined;
}

/** A repository's current branch, or `undefined` when it has none (unborn HEAD). */
async function branchOf(cwd: string): Promise<string | undefined> {
  const branch = await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return branch?.trim() || undefined;
}

/**
 * Collects directories that hold their own `.git` entry, below `cwd`. A `.git`
 * file is a submodule (its real gitdir lives in the parent's `.git/modules`); a
 * `.git` directory is a separate repository. Either way its presence is enough
 * to treat the directory as a repository root, which is much cheaper than
 * spawning git once per directory. The walk stops at a repository it found, so a
 * submodule's own internals contribute nothing.
 */
async function walk(root: string, directory: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_REPOS) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // An unreadable directory is not a reason to fail the whole scan.
    return;
  }
  if (directory !== root && entries.some((entry) => entry.name === '.git')) {
    found.push(toPosix(relative(root, directory)));
    return;
  }
  for (const entry of entries) {
    if (found.length >= MAX_REPOS) {
      return;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    await walk(root, join(directory, entry.name), depth + 1, found);
  }
}

/** Paths read with `/` on every platform, the way pi prints them. */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function gitText(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}
