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

/** Validates the host's answer: a host command reply is `unknown` on the wire. */
export function asGitStatus(value: unknown): GitStatus | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['isRepo'] !== true) {
    return typeof candidate['isRepo'] === 'boolean' ? { isRepo: false, files: [] } : undefined;
  }
  const files = Array.isArray(candidate['files'])
    ? candidate['files'].map(asFileStatus).filter((file): file is GitFileStatus => file !== undefined)
    : [];
  return { isRepo: true, files };
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
