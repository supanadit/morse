import { describe, expect, it } from 'vitest';
import { rankPalette, type PaletteItem } from './command-picker';

const ITEMS: PaletteItem[] = [
  { id: 'builtin:model', label: '/model', description: 'Select a model', badge: 'built-in' },
  { id: 'builtin:new', label: '/new', description: 'Start a new session', badge: 'built-in' },
  {
    id: 'builtin:compact',
    label: '/compact',
    description: 'Compact the current context',
    badge: 'built-in',
  },
  {
    id: 'command:skill:codebase-memory',
    label: '/skill:codebase-memory',
    description: 'Query the knowledge graph',
    badge: 'skill',
  },
  { id: 'command:fix-tests', label: '/fix-tests', description: 'Fix failing tests', badge: 'prompt' },
];

/** Ordering like the mention list: prefix, then substring, then description. */
describe('rankPalette', () => {
  it('puts a name prefix first', () => {
    expect(rankPalette(ITEMS, 'co').map((item) => item.id)).toEqual([
      'builtin:compact',
      'command:skill:codebase-memory',
    ]);
  });

  it('finds a command by a fragment of its name', () => {
    expect(rankPalette(ITEMS, 'fix').map((item) => item.id)).toEqual(['command:fix-tests']);
  });

  it('falls back to the description', () => {
    expect(rankPalette(ITEMS, 'knowledge').map((item) => item.id)).toEqual([
      'command:skill:codebase-memory',
    ]);
  });

  it('caps an unfiltered list', () => {
    expect(rankPalette(ITEMS, '', 2).map((item) => item.id)).toEqual(['builtin:model', 'builtin:new']);
  });

  it('drops every non-match', () => {
    expect(rankPalette(ITEMS, 'zzz')).toEqual([]);
  });
});
