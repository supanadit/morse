import { describe, expect, it } from 'vitest';
import { buildFileTree, fileGlyph, fileIcon } from './tree.js';

describe('buildFileTree', () => {
  it('nests files under the directories they imply', () => {
    const tree = buildFileTree(['src/app/main.ts', 'src/app/view.ts', 'README.md']);

    expect(tree.map((node) => node.name)).toEqual(['src', 'README.md']);
    const src = tree[0];
    expect(src.kind).toBe('dir');
    expect(src.children.map((node) => node.name)).toEqual(['app']);
    expect(src.children[0].children.map((node) => node.name)).toEqual(['main.ts', 'view.ts']);
    expect(src.children[0].children[0].path).toBe('src/app/main.ts');
  });

  it('keeps directories first and sorts each level alphabetically', () => {
    const tree = buildFileTree(['zeta.ts', 'src/', 'alpha.ts', 'Beta.ts']);

    expect(tree.map((node) => node.name)).toEqual(['src', 'alpha.ts', 'Beta.ts', 'zeta.ts']);
  });

  it('does not invent a duplicate for an entry listed twice', () => {
    const tree = buildFileTree(['a.ts', 'a.ts', 'src/', 'src/']);

    expect(tree.map((node) => node.name)).toEqual(['src', 'a.ts']);
    expect(tree.filter((node) => node.name === 'a.ts')).toHaveLength(1);
  });

  it('handles an empty listing', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('fileGlyph', () => {
  it('gives source, docs and config different marks', () => {
    expect(fileGlyph('main.ts')).toBe('◆');
    expect(fileGlyph('README.md')).toBe('¶');
    expect(fileGlyph('package.json')).toBe('⚙');
    expect(fileGlyph('styles.css')).toBe('◈');
    expect(fileGlyph('run.sh')).toBe('❯');
    expect(fileGlyph('LICENSE')).toBe('·');
  });
});

describe('fileIcon', () => {
  it('maps a language by extension', () => {
    expect(fileIcon('main.ts')).toBe('code');
    expect(fileIcon('app.py')).toBe('code');
  });

  it('matches the extension case-insensitively', () => {
    expect(fileIcon('README.MD')).toBe('markdown');
    expect(fileIcon('main.TS')).toBe('code');
  });

  it('reads a dotfile by its name, not its suffix', () => {
    expect(fileIcon('.gitignore')).toBe('git');
    expect(fileIcon('.env')).toBe('data');
  });

  it('prefers the whole name for a lockfile', () => {
    expect(fileIcon('package-lock.json')).toBe('lock');
    expect(fileIcon('pnpm-lock.yaml')).toBe('lock');
    expect(fileIcon('yarn.lock')).toBe('lock');
  });

  it('gives an unknown or missing extension the generic page', () => {
    expect(fileIcon('foo.xyz')).toBe('generic');
    expect(fileIcon('Makefile')).toBe('generic');
  });

  it('names the remaining shapes', () => {
    expect(fileIcon('logo.png')).toBe('image');
    expect(fileIcon('deploy.sh')).toBe('shell');
    expect(fileIcon('report.sql')).toBe('sql');
    expect(fileIcon('styles.css')).toBe('code');
  });
});
