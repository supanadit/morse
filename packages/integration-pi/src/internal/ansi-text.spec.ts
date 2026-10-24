import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi-text.js';

/**
 * The pi boundary strips terminal coloring before Morse renders extension text
 * as DOM. These tests pin that it removes control sequences only — never the
 * visible text an extension printed.
 */
describe('stripAnsi', () => {
  it('removes the truecolor SGR an extension gets from theme.fg', () => {
    expect(stripAnsi('\u001b[38;2;126;136;142mLSP Inactive\u001b[39m')).toBe('LSP Inactive');
  });

  it('removes a status that joins several colored parts', () => {
    const active = '\u001b[32mLSP Active: typescript\u001b[39m';
    const failed = '\u001b[31mLSP Failed: yaml\u001b[39m';
    expect(stripAnsi(`${active} \u00b7 ${failed}`)).toBe('LSP Active: typescript \u00b7 LSP Failed: yaml');
  });

  it('removes indexed/bold SGR and keeps the text', () => {
    expect(stripAnsi('\u001b[1m\u001b[38;5;240mdim\u001b[22m\u001b[39m')).toBe('dim');
  });

  it('keeps literal brackets an extension printed', () => {
    expect(stripAnsi('[1,3]')).toBe('[1,3]');
  });

  it('keeps widget box-drawing and text untouched', () => {
    expect(stripAnsi('Todos (0/0)')).toBe('Todos (0/0)');
    expect(stripAnsi('\u251c\u2500 \u25cf src/index.ts')).toBe('\u251c\u2500 \u25cf src/index.ts');
  });

  it('removes an OSC hyperlink but keeps its label', () => {
    expect(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007')).toBe('link');
  });

  it('is a no-op for plain text', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});
