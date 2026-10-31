/** The git panel: history, graph, per-file status, diffs and mutations. */

export interface GitCommit {
  hash: string;
  shortHash: string;
  /** Parent hashes, newest-first order; empty on a root commit. */
  parents: string[];
  /** Decorations (`%D`), already split: `HEAD -> main`, `tag: v1.0`, `origin/main`. */
  refs: string[];
  author: string;
  /** ISO 8601 author date, so the frontend can render a relative time. */
  date: string;
  subject: string;
}

/** What the `gitLog` host command answers: the active project's recent commits. */
export interface GitLog {
  /** False when the directory is not inside a git repository. */
  isRepo: boolean;
  /** Repository root, when `isRepo`. */
  root?: string;
  /** Current branch (`HEAD` short name), when `isRepo`. */
  branch?: string;
  commits: GitCommit[];
}

/** One changed path in the working tree, for the Explorer's git badges. */
export interface GitFileStatus {
  /** Path relative to the viewing session's directory, like `listFiles`. */
  path: string;
  /** Two-letter porcelain code: ` M`, `??`, `A `, `D `, `R `, `UU`, … */
  status: string;
}

/** What the `gitStatus` host command answers: the working tree's changes. */
export interface GitStatus {
  isRepo: boolean;
  files: GitFileStatus[];
}

/**
 * One repository the git panel lists. A project can hold more than one: the
 * repository the session directory sits in, plus any nested ones (a submodule,
 * or a separate repository under the project directory), which VS Code calls
 * its multiple source-control repositories.
 */
export interface GitRepoInfo {
  /**
   * Repository root relative to the session directory, with `/` separators.
   * Empty (`''`) for the session's own repository; the panel sends this back as
   * the `repo` argument of every git command so the host knows which one to run in.
   */
  path: string;
  /** Repository root on disk (absolute). */
  root: string;
  /** A short display name: the root's folder name (or the session directory's). */
  name: string;
  /** True for the repository the session directory sits in. */
  current: boolean;
  /** Current branch (`HEAD` short name), when known. */
  branch?: string;
}

/** What the `gitRepos` host command answers: the repositories under a project. */
export interface GitRepos {
  /** False when the directory is inside no repository and holds none beneath it. */
  isRepo: boolean;
  /** The session's own repository first, then nested ones by path. */
  repos: GitRepoInfo[];
}

/**
 * What the `gitCommitFiles` host command answers: the paths a single commit
 * touched, with the status each had in that commit (`M`, `A`, `D`, `R`, …).
 */
export interface GitCommitFiles {
  isRepo: boolean;
  hash: string;
  files: GitFileStatus[];
}

/**
 * What the `gitSync` host command answers: how far HEAD is from its upstream,
 * for the panel's pull/push controls. `behind` is commits to pull, `ahead` is
 * commits to push.
 */
export interface GitSync {
  isRepo: boolean;
  /** Current branch (`HEAD` short name), when `isRepo`. */
  branch?: string;
  /** The tracked remote branch (`origin/main`), when one is configured. */
  upstream?: string;
  ahead: number;
  behind: number;
}

/** What the `gitBranches` host command answers: what the panel can switch to. */
export interface GitBranches {
  isRepo: boolean;
  /** The checked-out branch (`HEAD` short name), when known. */
  current?: string;
  /** Local branch short names. */
  local: string[];
  /** Remote-tracking branches (`origin/main`), without `origin/HEAD`. */
  remote: string[];
  /** Tag names (checking one out detaches HEAD, the way git does). */
  tags: string[];
}

/** One line a file matched on, ready for the search panel's row. */

/**
 * What a git mutation answers (`gitCommit`, `gitCheckout`). `message` carries
 * git's own words when it refused, so the panel can say why nothing happened.
 */
export interface GitMutation {
  ok: boolean;
  message?: string;
}

/** What the `gitDiff` host command answers: one file's unified diff. */
export interface GitDiff {
  path: string;
  /** Unified diff text (`git diff HEAD -- <path>`); empty when there is none. */
  diff: string;
}
