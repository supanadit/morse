import { describe, expect, it } from 'vitest';
import {
  paletteGroups,
  parsePaletteQuery,
  scorePaletteEntry,
  type PaletteEntry,
} from './commands.js';

function entry(over: Partial<PaletteEntry> & Pick<PaletteEntry, 'id' | 'kind' | 'label'>): PaletteEntry {
  return over;
}

describe('parsePaletteQuery', () => {
  it('reads a flat query as the whole list', () => {
    expect(parsePaletteQuery('')).toEqual({ filter: '' });
    expect(parsePaletteQuery('  sonnet  ')).toEqual({ filter: 'sonnet' });
  });

  it('takes a leading source character off and locks that source', () => {
    expect(parsePaletteQuery('>')).toEqual({ kind: 'command', filter: '' });
    expect(parsePaletteQuery('> compact')).toEqual({ kind: 'command', filter: 'compact' });
    expect(parsePaletteQuery('# sidebar')).toEqual({ kind: 'session', filter: 'sidebar' });
    expect(parsePaletteQuery('@ app.ts')).toEqual({ kind: 'file', filter: 'app.ts' });
    expect(parsePaletteQuery(': morse')).toEqual({ kind: 'project', filter: 'morse' });
  });

  it('only treats a prefix at the very start as a source', () => {
    // `a > b` is a query with a `>` in it, not a locked command list.
    expect(parsePaletteQuery('a > b')).toEqual({ filter: 'a > b' });
  });
});

describe('scorePaletteEntry', () => {
  const row = entry({
    id: 'command:palette',
    kind: 'command',
    label: 'Open palette',
    description: 'Search every source',
    keywords: 'command.palette',
  });

  it('ranks a label prefix above a word, a substring and a subsequence', () => {
    const starts = scorePaletteEntry(row, 'open');
    const word = scorePaletteEntry(row, 'palette');
    const substring = scorePaletteEntry(row, 'lette');
    const fuzzy = scorePaletteEntry(row, 'opl');

    expect(starts).toBe(0);
    expect(word).toBe(1);
    expect(substring).toBe(2);
    expect(fuzzy).toBeGreaterThan(substring);
  });

  it('finds a match in the hidden keywords last, and reports nothing as infinite', () => {
    // `source` is not in the label, only in the description shown under it.
    expect(scorePaletteEntry(row, 'source')).toBe(1_000);
    expect(scorePaletteEntry(row, 'zzz')).toBe(Number.POSITIVE_INFINITY);
  });

  it('treats an empty query as a match for everything', () => {
    expect(scorePaletteEntry(row, '')).toBe(0);
  });
});

describe('paletteGroups', () => {
  const entries: PaletteEntry[] = [
    entry({ id: 'command:compact', kind: 'command', label: 'Compact the conversation' }),
    entry({ id: 'command:new', kind: 'command', label: 'New session' }),
    entry({ id: 'tab:session-1', kind: 'tab', label: 'Sidebar overhaul' }),
    entry({ id: 'session:1', kind: 'session', label: 'Sidebar overhaul', description: '/work/morse' }),
    entry({ id: 'session:2', kind: 'session', label: 'Greeting' }),
    entry({ id: 'project:morse', kind: 'project', label: 'morse', description: '/work/morse' }),
    entry({ id: 'file:app', kind: 'file', label: 'app.ts', keywords: 'packages/ui-angular/src/app/app.ts' }),
    entry({ id: 'model:mock-1', kind: 'model', label: 'Mock Model' }),
    entry({ id: 'thinking:low', kind: 'thinking', label: 'low' }),
  ];

  it('prints one section per source, in a fixed order', () => {
    const groups = paletteGroups(entries, '');

    expect(groups.map((group) => group.kind)).toEqual([
      'command',
      'tab',
      'session',
      'project',
      'file',
      'model',
      'thinking',
    ]);
    expect(groups.map((group) => group.title)).toEqual([
      'Commands',
      'Open tabs',
      'Sessions',
      'Projects',
      'Files',
      'Models',
      'Thinking',
    ]);
  });

  it('caps the flat, empty list per section instead of dumping everything', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      entry({ id: `session:${index}`, kind: 'session', label: `Session ${index}` }),
    );

    const [sessions] = paletteGroups(many, '', 50, 3);
    expect(sessions.entries).toHaveLength(3);
    expect(sessions.entries.map((row) => row.label)).toEqual([
      'Session 0',
      'Session 1',
      'Session 2',
    ]);
  });

  it('raises the cap once the reader is looking for something', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      entry({ id: `session:${index}`, kind: 'session', label: `Session ${index}` }),
    );

    const [sessions] = paletteGroups(many, 'session', 50, 3);
    expect(sessions.entries).toHaveLength(20);
  });

  it('locks to one source and drops the rest when a prefix is typed', () => {
    const groups = paletteGroups(entries, '# sidebar');

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('session');
    expect(groups[0].entries.map((row) => row.label)).toEqual(['Sidebar overhaul']);
  });

  it('returns nothing when a locked source has no entries here', () => {
    // A VS Code-shaped host sends no projects; `:` must say "no match", not
    // fall back to the flat list.
    const noProjects = entries.filter((row) => row.kind !== 'project');
    expect(paletteGroups(noProjects, ': morse')).toEqual([]);
  });

  it('drops a section whose rows all miss the query', () => {
    const groups = paletteGroups(entries, 'sidebar');

    expect(groups.map((group) => group.kind)).toEqual(['tab', 'session']);
  });

  it('breaks ties by label, so the order does not depend on insertion', () => {
    const tied = [
      entry({ id: 'session:d', kind: 'session', label: 'Delta' }),
      entry({ id: 'session:a', kind: 'session', label: 'Alpha' }),
    ];

    const [sessions] = paletteGroups(tied, 'l');
    expect(sessions.entries.map((row) => row.label)).toEqual(['Alpha', 'Delta']);
  });
});
