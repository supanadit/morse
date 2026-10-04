import type { GitFileStatus, GitStatus } from '@morse/protocol';

/** The single letter an Explorer badge shows for a changed file. */
export type ChangeKind = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';

/**
 * Maps git's two-letter porcelain code to the badge letter: untracked, added,
 * deleted, renamed, conflicted, or modified. `T` (type change) reads as a edit.
 */
export function changeKind(code: string): ChangeKind | undefined {
  if (code === '??') {
    return 'U';
  }
  if (code.includes('U') || code === 'AA' || code === 'DD') {
    return 'C';
  }
  if (code.includes('R') || code.includes('C')) {
    return 'R';
  }
  if (code.includes('D')) {
    return 'D';
  }
  if (code.includes('A')) {
    return 'A';
  }
  if (code.includes('M') || code.includes('T')) {
    return 'M';
  }
  return undefined;
}

/**
 * An unmerged/conflicted entry. `git status` prints these as `UU`, `AA`, `DD`
 * and friends: none of them is a staged change, so the panel leaves them in the
 * unstaged list until `git add` marks them resolved.
 */
function isConflict(code: string): boolean {
  return code.includes('U') || code === 'AA' || code === 'DD';
}

/** True when the index holds a change for this path (the `X` letter). */
export function isStaged(code: string): boolean {
  if (isConflict(code)) {
    return false;
  }
  const index = code[0];
  return index !== undefined && index !== ' ' && index !== '?';
}

/** True when the working tree holds a change for this path (the `Y` letter). */
export function isUnstaged(code: string): boolean {
  if (isConflict(code) || code === '??') {
    return true;
  }
  const worktree = code[1];
  return worktree !== undefined && worktree !== ' ' && worktree !== '?';
}

/** The badge for a path's staged side: the `X` letter alone. */
export function stagedKind(code: string): ChangeKind | undefined {
  return letterKind(code[0]);
}

/** The badge for a path's unstaged side: the `Y` letter alone. */
export function unstagedKind(code: string): ChangeKind | undefined {
  if (code === '??') {
    return 'U';
  }
  if (isConflict(code)) {
    return 'C';
  }
  return letterKind(code[1]);
}

function letterKind(letter: string | undefined): ChangeKind | undefined {
  switch (letter) {
    case '?':
      return 'U';
    case 'M':
    case 'T':
      return 'M';
    case 'A':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
    case 'C':
      return 'R';
    default:
      return undefined;
  }
}

/** Validates the host's answer: a host command reply is `unknown` on the wire. */
export function asGitStatus(value: unknown): GitStatus | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['isRepo'] !== true) {
    return typeof candidate['isRepo'] === 'boolean' ? { isRepo: false, files: [] } : undefined;
  }
  return { isRepo: true, files: asFiles(candidate['files']) };
}

/**
 * Validates a `gitCommitFiles` answer. A commit that touched nothing here (a
 * subdirectory session, a merge) is an empty list, not a malformed reply.
 */
export function asCommitFiles(value: unknown): GitFileStatus[] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['isRepo'] !== 'boolean') {
    return undefined;
  }
  return asFiles(candidate['files']);
}

function asFiles(value: unknown): GitFileStatus[] {
  return Array.isArray(value)
    ? value.map(asFileStatus).filter((file): file is GitFileStatus => file !== undefined)
    : [];
}

/** The changed paths as a `path -> letter` map, for the Explorer's rows. */
export function statusByPath(status: GitStatus | undefined): Map<string, ChangeKind> {
  const map = new Map<string, ChangeKind>();
  for (const file of status?.files ?? []) {
    const kind = changeKind(file.status);
    if (kind !== undefined) {
      map.set(file.path, kind);
    }
  }
  return map;
}

function asFileStatus(value: unknown): GitFileStatus | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const file = value as Record<string, unknown>;
  const path = file['path'];
  const status = file['status'];
  if (typeof path !== 'string' || typeof status !== 'string') {
    return undefined;
  }
  return { path, status };
}
