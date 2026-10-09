import { describe, expect, it } from 'vitest';
import { rankFiles, scoreMatch } from './file-picker';

const FILES = [
  'AGENTS.md',
  'README.md',
  'packages/extension/README.md',
  'packages/ui-angular/README.md',
  'packages/ui-angular/src/app/app.ts',
];

/** Ordering like pi's mention list. */
describe('rankFiles', () => {
  it('puts the shallowest name match first and drops the rest', () => {
    expect(rankFiles(FILES, 'readme')).toEqual([
      'README.md',
      'packages/extension/README.md',
      'packages/ui-angular/README.md',
    ]);
  });

  it('finds a file by a fragment of its path', () => {
    expect(rankFiles(FILES, 'ui-angular/src')).toEqual(['packages/ui-angular/src/app/app.ts']);
  });

  it('caps an unfiltered list', () => {
    expect(rankFiles(FILES, '', 2)).toEqual(['AGENTS.md', 'README.md']);
  });
});

describe('scoreMatch', () => {
  it('ranks a prefix of the name above a match inside it', () => {
    expect(scoreMatch('readme.md', 'rea')).toBeLessThan(scoreMatch('my-readme.md', 'rea'));
  });

  it('ranks a name match above a path-only match', () => {
    expect(scoreMatch('src/readme.ts', 'src')).toBeGreaterThan(
      scoreMatch('src/deep/readme.ts', 'readme'),
    );
  });

  it('ignores files that do not match at all', () => {
    expect(scoreMatch('src/app.ts', 'readme')).toBe(Number.POSITIVE_INFINITY);
  });

  it('scores a directory by its name, not the trailing slash', () => {
    expect(scoreMatch('docs/', 'docs')).toBe(0);
    expect(scoreMatch('docs/INSTALL.md', 'docs')).toBeGreaterThan(scoreMatch('docs/', 'docs'));
  });
});

/** Directories (`docs/`) come first and a trailing `/` means "drill in". */
describe('rankFiles with directories', () => {
  const TREE = ['docs/', 'docs/INSTALL.md', 'docs/PACKAGING.md', 'src/', 'src/app.ts'];

  it('puts the matching directory above the files inside it', () => {
    expect(rankFiles(TREE, 'doc')).toEqual(['docs/', 'docs/INSTALL.md', 'docs/PACKAGING.md']);
  });

  it('lists only the contents once the query ends with a slash', () => {
    expect(rankFiles(TREE, 'docs/')).toEqual(['docs/INSTALL.md', 'docs/PACKAGING.md']);
  });

  it('ranks directories first when the query is empty', () => {
    expect(rankFiles(TREE, '', 3)).toEqual(['src/', 'docs/', 'src/app.ts']);
  });
});
