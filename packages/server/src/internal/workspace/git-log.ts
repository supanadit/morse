import { execFile } from 'node:child_process';
import { relative } from 'node:path';
import type { GitCommit, GitDiff, GitFileStatus, GitLog, GitStatus } from '@morse/protocol';
import { resolveWithin } from './file-store.js';

/**
 * How many commits the panel reads. A history view is for orientation, not for
 * replaying a repository: past a few hundred rows the graph is unreadable and
 * the log gets slow, so the list is capped and says so.
 */
const DEFAULT_MAX_COMMITS = 250;
const HARD_MAX_COMMITS = 500;

/** Field separator (US) and record separator (RS): safe inside any commit text. */
const FIELD = '\u001f';
const RECORD = '\u001e';
const PRETTY_FORMAT = ['%H', '%h', '%P', '%D', '%an', '%aI', '%s'].join(FIELD) + RECORD;

/**
 * The active project's git history for the browser host's git panel. The project
 * is the viewing session's directory (already approved by `ProjectPolicy`), never
 * a path the client names. A directory that is not a repository is a normal
 * answer (`isRepo: false`), not an error — the panel says "no repository here".
 *
 * `--all --date-order` walks every ref so the graph shows side branches, and the
 * lanes are derived by the frontend from each commit's `parents`.
 */
export async function readGitLog(
  cwd: string,
  requestedMax?: number,
  requestedSkip?: number,
): Promise<GitLog> {
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() !== 'true') {
    return { isRepo: false, commits: [] };
  }
  const max = clampMax(requestedMax);
  const skip = clampSkip(requestedSkip);
  const [root, branch, raw] = await Promise.all([
    gitText(['rev-parse', '--show-toplevel'], cwd),
    gitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    gitText(
      [
        'log',
        '--all',
        '--date-order',
        `--skip=${skip}`,
        `--max-count=${max}`,
        `--pretty=format:${PRETTY_FORMAT}`,
      ],
      cwd,
    ),
  ]);
  return {
    isRepo: true,
    root: root?.trim() || cwd,
    branch: branch?.trim() || undefined,
    commits: parseCommits(raw ?? ''),
  };
}

function clampMax(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_COMMITS;
  }
  return Math.max(1, Math.min(HARD_MAX_COMMITS, Math.floor(requested)));
}

/**
 * The working tree's changed paths, for the Explorer's per-file git badges.
 * Paths are made relative to `cwd` (matching `listFiles`), so a session opened
 * in a subdirectory of the repository lines up with the listing it shows.
 */
export async function readGitStatus(cwd: string): Promise<GitStatus> {
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() !== 'true') {
    return { isRepo: false, files: [] };
  }
  const [prefix, raw] = await Promise.all([
    gitText(['rev-parse', '--show-prefix'], cwd),
    gitText(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd),
  ]);
  return { isRepo: true, files: parseStatus(raw ?? '', prefix?.trim() ?? '') };
}

/**
 * Porcelain v1 with `-z`: one `XY path` record per entry, NUL-separated, and a
 * rename/copy adds the origin path as a following record.
 */
function parseStatus(raw: string, root: string): GitFileStatus[] {
  const records = raw.split('\0');
  const files: GitFileStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    // A rename/copy keeps its new path here and its origin in the next record.
    if (status[0] === 'R' || status[0] === 'C') {
      index += 1;
    }
    const full = record.slice(3);
    if (root.length > 0 && !full.startsWith(root)) {
      continue;
    }
    const path = full.slice(root.length);
    if (path.length > 0) {
      files.push({ path: toPosix(path), status });
    }
  }
  return files;
}

/**
 * One file's unified diff against HEAD, for the preview's diff modes. The path
 * is resolved inside the viewing session's directory, the same guard `readFile`
 * uses, so a client cannot name a file outside the project. An untracked file
 * has no diff against HEAD; the frontend renders its content as all-added.
 */
export async function readGitDiff(cwd: string, requested: string): Promise<GitDiff> {
  const rel = toPosix(relative(cwd, resolveWithin(cwd, requested)));
  const diff = await gitText(
    ['diff', '--no-color', '--no-ext-diff', '-U3', 'HEAD', '--', rel],
    cwd,
  );
  return { path: rel, diff: diff ?? '' };
}

/**
 * Stages the named paths in the viewing session's repository (`git add`). Paths
 * are resolved inside `cwd` exactly like `readFile`, so a client cannot stage
 * anything outside its project. The fresh working tree comes back as the answer,
 * so the panel updates without a second `gitStatus` round trip.
 */
export async function stageGitPaths(cwd: string, requested: readonly string[]): Promise<GitStatus> {
  const paths = resolvePaths(cwd, requested);
  if (paths.length > 0) {
    await gitRun(['add', '--', ...paths], cwd);
  }
  return readGitStatus(cwd);
}

/**
 * Unstages the named paths (`git reset HEAD`), keeping the working-tree change:
 * a staged edit becomes an unstaged one, and an added file becomes untracked
 * again. An unborn `HEAD` (a repository with no commits) cannot be reset, so the
 * entry is removed from the index directly instead.
 */
export async function unstageGitPaths(cwd: string, requested: readonly string[]): Promise<GitStatus> {
  const paths = resolvePaths(cwd, requested);
  if (paths.length > 0) {
    const reset = await gitRun(['reset', '--quiet', 'HEAD', '--', ...paths], cwd);
    if (!reset) {
      await gitRun(['rm', '--cached', '--quiet', '--', ...paths], cwd);
    }
  }
  return readGitStatus(cwd);
}

/** Paths read with `/` on every platform, the way pi prints them. */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/** How many commits to walk past while paging towards the root commit. */
function clampSkip(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return 0;
  }
  return Math.max(0, Math.floor(requested));
}

/** One record per commit: `hash · short · parents · refs · author · date · subject`. */
function parseCommits(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split(RECORD)) {
    const line = record.replace(/^\n+/, '');
    if (line.trim().length === 0) {
      continue;
    }
    const fields = line.split(FIELD);
    const [hash, shortHash, parents, refs, author, date, subject] = fields;
    if (!hash || !shortHash || !date) {
      continue;
    }
    commits.push({
      hash,
      shortHash,
      parents: (parents ?? '').split(' ').filter((parent) => parent.length > 0),
      refs: parseRefs(refs ?? ''),
      author: author ?? '',
      date,
      subject: subject ?? '',
    });
  }
  return commits;
}

/**
 * `%D` prints decorations comma-separated (`HEAD -> main, tag: v1.0`). The panel
 * renders each as a chip, so split here rather than shipping one long string.
 */
function parseRefs(raw: string): string[] {
  const refs = raw
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
  return refs;
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

/** Resolves client paths inside `cwd` and normalises them to `/` separators. */
function resolvePaths(cwd: string, requested: readonly string[]): string[] {
  return requested
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .map((path) => toPosix(relative(cwd, resolveWithin(cwd, path))));
}

/** A mutation: true when git accepted it, false when it failed (e.g. unborn HEAD). */
function gitRun(args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error) => resolve(error === null),
    );
  });
}
