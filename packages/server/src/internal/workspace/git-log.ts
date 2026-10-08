import { execFile } from 'node:child_process';
import { relative } from 'node:path';
import type {
  GitBranches,
  GitCommit,
  GitCommitFiles,
  GitDiff,
  GitFileStatus,
  GitLog,
  GitMutation,
  GitStatus,
  GitSync,
} from '@morse/protocol';
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
 *
 * One call, not three: `--relative` asks git itself for cwd-relative paths with
 * everything outside the directory dropped — exactly the prefix-stripping and
 * filtering this used to do by hand, behind `rev-parse --is-inside-work-tree`
 * and `--show-prefix`. `git status` also fails outside a work tree, which is the
 * same "not a repository" answer those two calls produced. This is the command
 * the Explorer polls, so the two saved spawns are every four seconds rather than
 * once.
 *
 * `--relative` needs git 2.13. An older git fails here for its own reason, so
 * the explicit path is kept as the fallback and the answer stays what it was.
 */
export async function readGitStatus(cwd: string): Promise<GitStatus> {
  const relative = await gitText(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--relative'],
    cwd,
  );
  if (relative !== undefined) {
    return { isRepo: true, files: parseStatus(relative, '') };
  }
  return readGitStatusByPrefix(cwd);
}

/**
 * The three-call reading of the same thing, for a git too old for `--relative`
 * (and for any other failure, which it reports the way it always did).
 */
async function readGitStatusByPrefix(cwd: string): Promise<GitStatus> {
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
 * The paths a commit touched, for the git panel's expandable row. Paths are made
 * relative to `cwd` (`--relative`), matching `listFiles` and `readGitStatus`, so
 * a session opened in a subdirectory sees only what it can open. A commit that
 * touched nothing there is an empty list, not an error.
 */
export async function readCommitFiles(cwd: string, requested: string): Promise<GitCommitFiles> {
  const hash = requested.trim();
  if (!isCommitHash(hash)) {
    return { isRepo: false, hash, files: [] };
  }
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() !== 'true') {
    return { isRepo: false, hash, files: [] };
  }
  const raw = await gitText(
    ['show', '--name-status', '--format=', '-z', '--find-renames', '--relative', hash],
    cwd,
  );
  return { isRepo: true, hash, files: parseNameStatus(raw ?? '') };
}

/**
 * One file's diff *inside a commit* (`git show <hash> -- <path>`), for a file
 * opened from the git panel's commit row. The path is resolved inside `cwd`,
 * exactly like `readGitDiff`. A root commit shows the whole file as added.
 */
export async function readCommitDiff(cwd: string, hash: string, requested: string): Promise<GitDiff> {
  const rel = toPosix(relative(cwd, resolveWithin(cwd, requested)));
  if (!isCommitHash(hash.trim())) {
    return { path: rel, diff: '' };
  }
  const diff = await gitText(
    ['show', '--format=', '--no-color', '--no-ext-diff', '-U3', '--relative', hash.trim(), '--', rel],
    cwd,
  );
  return { path: rel, diff: diff ?? '' };
}

/** A revision the client may name: a hex object id, never an option or a ref. */
function isCommitHash(hash: string): boolean {
  return /^[0-9a-fA-F]{4,40}$/.test(hash);
}

/**
 * `git show --name-status -z` pairs a status with its path, NUL-separated, and a
 * rename/copy carries both the old and the new path. Only the new path is kept,
 * with the status reduced to its letter so the shared badge mapping applies.
 */
function parseNameStatus(raw: string): GitFileStatus[] {
  const tokens = raw.split('\0');
  const files: GitFileStatus[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) {
      continue;
    }
    const letter = status[0] ?? '';
    const rename = letter === 'R' || letter === 'C';
    const path = tokens[index + (rename ? 2 : 1)];
    index += rename ? 2 : 1;
    if (path) {
      files.push({ path: toPosix(path), status: `${letter} ` });
    }
  }
  return files;
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

/**
 * How far HEAD is from its upstream: `behind` commits to pull, `ahead` commits
 * to push. A branch with no upstream (or an unborn branch) reports zero for both,
 * so the panel still shows the pull/push controls without a distance.
 */
export async function readGitSync(cwd: string): Promise<GitSync> {
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() !== 'true') {
    return { isRepo: false, ahead: 0, behind: 0 };
  }
  const [branch, upstream] = await Promise.all([
    gitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    gitText(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd),
  ]);
  const name = branch?.trim() || undefined;
  const tracked = upstream?.trim() || undefined;
  if (tracked === undefined) {
    return { isRepo: true, branch: name, ahead: 0, behind: 0 };
  }
  const counts = await gitText(
    ['rev-list', '--left-right', '--count', `${tracked}...HEAD`],
    cwd,
  );
  const [behind, ahead] = parseCounts(counts ?? '');
  return { isRepo: true, branch: name, upstream: tracked, ahead, behind };
}

/** Pulls the upstream (`git pull`) and reports the new distance. */
export async function pullGit(cwd: string): Promise<GitSync> {
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() === 'true') {
    await gitRun(['pull', '--no-edit'], cwd, 180_000);
  }
  return readGitSync(cwd);
}

/**
 * Pushes HEAD (`git push`) and reports the new distance. `--follow-tags` sends
 * the annotated tags that point into the pushed history, so a release tag travels
 * with the commit it names instead of waiting for a separate `git push --tags`.
 */
export async function pushGit(cwd: string): Promise<GitSync> {
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() === 'true') {
    await gitRun(['push', '--follow-tags'], cwd, 180_000);
  }
  return readGitSync(cwd);
}

/**
 * The branches the panel can switch to: the current one, the locals, the
 * remote-tracking branches (minus `origin/HEAD`, which is not a branch), and the
 * tags (checking one out detaches HEAD).
 */
export async function readGitBranches(cwd: string): Promise<GitBranches> {
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() !== 'true') {
    return { isRepo: false, local: [], remote: [], tags: [] };
  }
  const [current, local, remote, tags] = await Promise.all([
    gitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    gitText(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd),
    gitText(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], cwd),
    gitText(['for-each-ref', '--format=%(refname:short)', 'refs/tags'], cwd),
  ]);
  return {
    isRepo: true,
    current: current?.trim() || undefined,
    local: nonEmptyLines(local),
    remote: nonEmptyLines(remote).filter((name) => !name.endsWith('/HEAD')),
    tags: nonEmptyLines(tags),
  };
}

/** Commits the staged changes with `message`; git's refusal is reported back. */
export async function commitGit(cwd: string, message: string): Promise<GitMutation> {
  const text = message.trim();
  if (text.length === 0) {
    return { ok: false, message: 'A commit needs a message.' };
  }
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() !== 'true') {
    return { ok: false, message: 'This project is not a git repository.' };
  }
  const result = await gitExec(['commit', '-m', text], cwd, 60_000);
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, message: describeCommitFailure(result.output) };
}

/**
 * Switches branches, creating the branch first when `create` is set. The name is
 * validated as a refname, so a client cannot smuggle a git option into the
 * command line.
 */
export async function checkoutGit(
  cwd: string,
  branch: string,
  create: boolean,
): Promise<GitMutation> {
  const name = branch.trim();
  if (!isBranchName(name)) {
    return { ok: false, message: 'That is not a usable branch name.' };
  }
  const inside = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside?.trim() !== 'true') {
    return { ok: false, message: 'This project is not a git repository.' };
  }
  const result = await gitExec(
    create ? ['checkout', '-b', name] : ['checkout', name],
    cwd,
    60_000,
  );
  return { ok: result.ok, message: result.ok ? undefined : gitRefusal(result.output) };
}

/** A conservative refname guard: no options, whitespace, or revision syntax. */
function isBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('-') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.endsWith('/') &&
    !/\s/.test(name) &&
    !/[~^:?*\[\\]/.test(name)
  );
}

/**
 * What to tell the reader when `git commit` refused. "Nothing to commit" is the
 * everyday case — the branch is clean, or the changes were never staged — and it
 * gets a plain instruction instead of git's paragraph; anything else (a failing
 * hook, a rejected signature) keeps git's own line.
 */
function describeCommitFailure(output: string): string | undefined {
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(output)) {
    return 'Nothing is staged to commit. Stage a change first.';
  }
  return gitRefusal(output);
}

/**
 * The line from a refused command a reader should see: the first line that is
 * git's own, not Node's `Command failed: …` wrapper or the branch chatter
 * (`On branch main`, `Your branch is up to date with …`) that always leads a
 * commit's output. Capped so a hint stays a hint.
 */
function gitRefusal(output: string): string | undefined {
  const line = output
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.length > 0 &&
        !candidate.startsWith('Command failed:') &&
        !/^On branch /.test(candidate) &&
        !/^Your branch /.test(candidate),
    );
  if (line === undefined) {
    return undefined;
  }
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

function nonEmptyLines(output: string | undefined): string[] {
  return (output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `<behind>\t<ahead>` from `git rev-list --left-right --count`; 0 when unreadable. */
function parseCounts(raw: string): [number, number] {
  const [behind, ahead] = raw.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  return [Number.isFinite(behind) ? behind : 0, Number.isFinite(ahead) ? ahead : 0];
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

/**
 * A git mutation: true when git accepted it, false when it failed. A network
 * command (pull/push) gets a long timeout and no terminal prompt, so a missing
 * credential fails instead of hanging the host on a blocked stdin.
 */
async function gitRun(args: string[], cwd: string, timeout = 5_000): Promise<boolean> {
  return (await gitExec(args, cwd, timeout)).ok;
}

/**
 * Runs git and keeps both its verdict and its words: a refused command (nothing
 * staged, a failing hook, a checkout conflict) has its stderr to show the user.
 */
function gitExec(
  args: string[],
  cwd: string,
  timeout = 5_000,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_MERGE_AUTOEDIT: 'no',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, output: stdout.trim() });
          return;
        }
        // git writes a refusal to stderr *or* stdout — "nothing to commit" is on
        // stdout — while Node's `error.message` is only the `Command failed: git …`
        // wrapper around that same output. Prefer git's own words and keep the
        // wrapper only for a failure with no output at all (a spawn error).
        const output = [stderr.trim(), stdout.trim()]
          .filter((part) => part.length > 0)
          .join('\n');
        resolve({ ok: false, output: output.length > 0 ? output : error.message.trim() });
      },
    );
  });
}
