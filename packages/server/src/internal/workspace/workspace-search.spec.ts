import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnsupportedByHostError } from '@morse/system';
import { ripgrepAvailable, searchWorkspace, type WorkspaceSearchOptions } from './workspace-search';

let root = '';

/** Whether this machine has ripgrep; the ripgrep suite runs only where it does. */
const HAS_RG = await ripgrepAvailable();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morse-search-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One file in the temp project; `segments` may name a folder chain. */
function file(path: string, content: string | Buffer): string {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** The node walk's own answers, whatever the machine has installed. */
function node(options: WorkspaceSearchOptions): WorkspaceSearchOptions {
  return { ...options, engine: 'node' };
}

/**
 * The two engines promise the same observable behaviour — which files, which
 * lines, which columns, which caps — so the shared expectations run against the
 * walk unconditionally and against ripgrep wherever `rg` is installed.
 */
function commonSuite(engine: 'node' | 'ripgrep'): void {
  const options = (rest: WorkspaceSearchOptions): WorkspaceSearchOptions =>
    engine === 'node' ? node(rest) : { ...rest, engine: 'ripgrep' };

  it('groups matching lines by file, sorted by path', async () => {
    file('b.ts', 'export const needle = 1;\n');
    file('a.ts', 'first line\nneedle here\nneedle again\n');
    file('untouched.ts', 'nothing to see\n');
    const result = await searchWorkspace(root, options({ query: 'needle' }));
    expect(result.engine).toBe(engine);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
    expect(result.files.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts']);
    const first = result.files[0];
    expect(first.count).toBe(2);
    expect(first.lines).toEqual([
      { line: 2, text: 'needle here', columns: [1] },
      { line: 3, text: 'needle again', columns: [1] },
    ]);
  });

  it('reports every match column on a line, one-based within the line', async () => {
    file('x.txt', 'alpha beta alpha\n');
    const result = await searchWorkspace(root, options({ query: 'alpha' }));
    expect(result.files[0].lines[0].columns).toEqual([1, 12]);
    expect(result.files[0].count).toBe(2);
  });

  it('searches nested folders and hidden files, but never the skip list', async () => {
    file('src/deep/app.ts', 'a needle\n');
    file('.github/workflow.yml', 'a needle\n');
    file('node_modules/dep/index.js', 'a needle\n');
    file('dist/bundle.js', 'a needle\n');
    file('.git/hooks/pre-commit', 'a needle\n');
    const result = await searchWorkspace(root, options({ query: 'needle' }));
    expect(result.files.map((entry) => entry.path)).toEqual([
      '.github/workflow.yml',
      'src/deep/app.ts',
    ]);
  });

  it('never lists a file that did not match', async () => {
    file('empty.ts', 'export {};\n');
    const result = await searchWorkspace(root, options({ query: 'needle' }));
    expect(result.files).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("reads case the way ripgrep's smart case does, and obeys the override", async () => {
    file('s.txt', 'hello world\n');
    const smart = await searchWorkspace(root, options({ query: 'hello' }));
    expect(smart.total).toBe(1);
    const smartCapital = await searchWorkspace(root, options({ query: 'Hello' }));
    expect(smartCapital.total).toBe(0);
    const forced = await searchWorkspace(
      root,
      options({ query: 'Hello', caseSensitive: false }),
    );
    expect(forced.total).toBe(1);
    const forcedStrict = await searchWorkspace(
      root,
      options({ query: 'hello', caseSensitive: true }),
    );
    expect(forcedStrict.total).toBe(1);
  });

  it('filters with include and exclude globs (a bare name is any folder)', async () => {
    file('src/app.ts', 'a needle\n');
    file('src/readme.md', 'a needle\n');
    file('docs/guide.md', 'a needle\n');
    const included = await searchWorkspace(root, options({ query: 'needle', include: ['*.ts'] }));
    expect(included.files.map((entry) => entry.path)).toEqual(['src/app.ts']);
    const excluded = await searchWorkspace(
      root,
      options({ query: 'needle', exclude: ['src/**'] }),
    );
    expect(excluded.files.map((entry) => entry.path)).toEqual(['docs/guide.md']);
  });

  it('cuts a very long line to a window around its match', async () => {
    const long = `${'x'.repeat(500)}needle${'y'.repeat(500)}`;
    file('long.txt', `${long}\n`);
    const result = await searchWorkspace(root, options({ query: 'needle' }));
    const line = result.files[0].lines[0];
    expect(line.text.length).toBeLessThanOrEqual(301);
    expect(line.text).toContain('needle');
    const column = line.columns[0];
    expect(column).toBeGreaterThanOrEqual(1);
    expect(column).toBeLessThanOrEqual(line.text.length);
    expect(line.text.slice(column - 1, column - 1 + 6)).toBe('needle');
  });

  it('skips binary files', async () => {
    file('blob.bin', Buffer.from('needle\0needle\0needle', 'utf8'));
    file('plain.txt', 'needle\n');
    const result = await searchWorkspace(root, options({ query: 'needle' }));
    expect(result.files.map((entry) => entry.path)).toEqual(['plain.txt']);
  });

  it('stops at the match cap and says the search was truncated', async () => {
    file('flood.txt', `${'needle\n'.repeat(1_200)}`);
    const result = await searchWorkspace(root, options({ query: 'needle' }));
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(1_000);
    expect(result.files[0].count).toBe(1_000);
  });

  it('refuses an empty query and a flood of patterns', async () => {
    await expect(searchWorkspace(root, node({ query: '   ' }))).rejects.toBeInstanceOf(
      UnsupportedByHostError,
    );
    // Distinct patterns: identical ones are deduplicated before the cap, which
    // is the point — a flood of the same glob is one glob, not a resource.
    await expect(
      searchWorkspace(
        root,
        node({ query: 'x', include: Array.from({ length: 33 }, (_, i) => `*.t${i}`) }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedByHostError);
  });
}

describe('searchWorkspace (node walk)', () => {
  commonSuite('node');

  it('is what `auto` answers when ripgrep is missing', async () => {
    file('a.txt', 'needle\n');
    const result = await searchWorkspace(root, { query: 'needle' });
    // Whatever the machine has, `auto` picks an engine and says which it was.
    expect(result.engine).toBe(HAS_RG ? 'ripgrep' : 'node');
    expect(result.files.map((entry) => entry.path)).toEqual(['a.txt']);
  });
});

describe.skipIf(!HAS_RG)('searchWorkspace (ripgrep)', () => {
  commonSuite('ripgrep');

  it('honours .gitignore, which the walk cannot', async () => {
    // ripgrep applies .gitignore only inside a real repository, so the fixture
    // is one — `git init` is no harder than the fixtures around it.
    file('.gitignore', 'ignored/\n');
    file('ignored/secrets.txt', 'needle\n');
    file('kept.txt', 'needle\n');
    execFileSync('git', ['init', '-q', root]);
    const result = await searchWorkspace(root, { engine: 'ripgrep', query: 'needle' });
    expect(result.files.map((entry) => entry.path)).toEqual(['kept.txt']);
  });
});
