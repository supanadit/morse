import type { GitRepoInfo, GitRepos } from '@morse/protocol';

/**
 * Validates the host's answer to `gitRepos`: the repositories under the viewing
 * project. A directory that is inside no repository and holds none beneath it is
 * a normal answer (`isRepo: false`), not a malformed reply.
 */
export function asGitRepos(value: unknown): GitRepos | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['isRepo'] !== 'boolean') {
    return undefined;
  }
  if (candidate['isRepo'] !== true) {
    return { isRepo: false, repos: [] };
  }
  return { isRepo: true, repos: asRepos(candidate['repos']) };
}

function asRepos(value: unknown): GitRepoInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(asRepo)
    .filter((repo): repo is GitRepoInfo => repo !== undefined);
}

function asRepo(value: unknown): GitRepoInfo | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const repo = value as Record<string, unknown>;
  const root = repo['root'];
  if (typeof root !== 'string' || root.length === 0) {
    return undefined;
  }
  return {
    path: typeof repo['path'] === 'string' ? repo['path'] : '',
    root,
    name: typeof repo['name'] === 'string' && repo['name'].length > 0 ? repo['name'] : root,
    current: repo['current'] === true,
    branch: typeof repo['branch'] === 'string' ? repo['branch'] : undefined,
  };
}
