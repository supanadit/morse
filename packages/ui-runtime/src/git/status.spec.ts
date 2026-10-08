import { describe, expect, it } from 'vitest';
import {
  asCommitFiles,
  asGitStatus,
  changeKind,
  isStaged,
  isUnstaged,
  stagedKind,
  statusByPath,
  unstagedKind,
} from './status.js';

describe('changeKind', () => {
  it('reads a porcelain code as the badge letter', () => {
    expect(changeKind(' M')).toBe('M');
    expect(changeKind('M ')).toBe('M');
    expect(changeKind('A ')).toBe('A');
    expect(changeKind('D ')).toBe('D');
    expect(changeKind('R ')).toBe('R');
    expect(changeKind('??')).toBe('U');
    expect(changeKind('UU')).toBe('C');
    expect(changeKind('T ')).toBe('M');
  });

  it('ignores a clean entry', () => {
    expect(changeKind('  ')).toBeUndefined();
  });
});

describe('staged and unstaged sides', () => {
  it('splits the two letters of the code', () => {
    // `X` is the index, `Y` the working tree.
    expect([isStaged(' M'), isUnstaged(' M')]).toEqual([false, true]);
    expect([isStaged('M '), isUnstaged('M ')]).toEqual([true, false]);
    expect([isStaged('A '), isUnstaged('A ')]).toEqual([true, false]);
    expect([isStaged('??'), isUnstaged('??')]).toEqual([false, true]);
  });

  it('puts a path edited on both sides in both lists', () => {
    expect([isStaged('MM'), isUnstaged('MM')]).toEqual([true, true]);
  });

  it('leaves a conflict unstaged until it is resolved', () => {
    expect([isStaged('UU'), isUnstaged('UU')]).toEqual([false, true]);
    expect([isStaged('AA'), isUnstaged('AA')]).toEqual([false, true]);
  });

  it('reads each side\u2019s own badge', () => {
    // An added-then-modified file: `A` in the index, `M` in the working tree.
    expect(stagedKind('AM')).toBe('A');
    expect(unstagedKind('AM')).toBe('M');
    expect(stagedKind(' D')).toBeUndefined();
    expect(unstagedKind(' D')).toBe('D');
    expect(unstagedKind('??')).toBe('U');
    expect(unstagedKind('UU')).toBe('C');
  });
});

describe('asGitStatus', () => {
  it('keeps the files it understands and drops the rest', () => {
    const parsed = asGitStatus({
      isRepo: true,
      files: [{ path: 'a.ts', status: ' M' }, { path: 1 }, null, { status: '??' }],
    });
    expect(parsed?.files).toEqual([{ path: 'a.ts', status: ' M' }]);
  });

  it('rejects a reply that is not a status', () => {
    expect(asGitStatus(undefined)).toBeUndefined();
    expect(asGitStatus({ files: [] })).toBeUndefined();
  });

  it('maps paths to their badge letter', () => {
    const map = statusByPath({
      isRepo: true,
      files: [
        { path: 'a.ts', status: ' M' },
        { path: 'b.ts', status: '??' },
      ],
    });
    expect([...map.entries()]).toEqual([
      ['a.ts', 'M'],
      ['b.ts', 'U'],
    ]);
  });
});

describe('asCommitFiles', () => {
  it('keeps a commit\u2019s files and drops the malformed rows', () => {
    const files = asCommitFiles({
      isRepo: true,
      hash: 'abc123',
      files: [{ path: 'a.ts', status: 'M ' }, { path: 1 }, null],
    });
    expect(files).toEqual([{ path: 'a.ts', status: 'M ' }]);
  });

  it('reads a commit that touched nothing as an empty list', () => {
    expect(asCommitFiles({ isRepo: true, hash: 'abc123' })).toEqual([]);
  });

  it('rejects a reply that is not a commit file list', () => {
    expect(asCommitFiles(undefined)).toBeUndefined();
    expect(asCommitFiles({ files: [] })).toBeUndefined();
  });
});
