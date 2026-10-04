import { describe, expect, it } from 'vitest';
import { asGitStatus, changeKind, statusByPath } from './git-status';

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
