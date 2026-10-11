import { describe, expect, it } from 'vitest';
import { asGitRepos } from './repos.js';

describe('asGitRepos', () => {
  it('keeps the repositories it understands and drops the rest', () => {
    const repos = asGitRepos({
      isRepo: true,
      repos: [
        { path: '', root: '/p', name: 'p', current: true, branch: 'main' },
        { path: 'sub', root: '/p/sub', name: 'sub', current: false },
        { root: '' },
        { path: 'x' },
      ],
    });

    expect(repos?.repos).toHaveLength(2);
    expect(repos?.repos[0]).toEqual({
      path: '',
      root: '/p',
      name: 'p',
      current: true,
      branch: 'main',
    });
    // A nested repo with no branch is still a repo; `current` defaults false.
    expect(repos?.repos[1]).toEqual({
      path: 'sub',
      root: '/p/sub',
      name: 'sub',
      current: false,
      branch: undefined,
    });
  });

  it('treats a non-repository as a normal empty answer', () => {
    expect(asGitRepos({ isRepo: false })).toEqual({ isRepo: false, repos: [] });
  });

  it('rejects a reply that is not a repo list', () => {
    expect(asGitRepos(undefined)).toBeUndefined();
    expect(asGitRepos({ repos: [] })).toBeUndefined();
  });
});
