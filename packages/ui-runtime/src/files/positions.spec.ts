// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { domRangeFor, identifierAt, offsetAt, pointAt, sourceOffsetIn } from './positions.js';

const TEXT = ['const a = 1;', 'function b() {', '  return a;', '}', ''].join('\n');

/**
 * A code element whose text is split across spans, the way highlight.js emits it.
 * Built with `createElement`/`textContent` rather than markup: the shape under
 * test is the text-node layout, and parsing a string to get it would be a
 * different code path than the one the component sees.
 */
function dom(segments: readonly string[]): HTMLElement {
  const root = document.createElement('div');
  for (const segment of segments) {
    const span = document.createElement('span');
    span.textContent = segment;
    root.appendChild(span);
  }
  return root;
}

/** `const a = 1;` as one span per run of text, so offsets are easy to state. */
const TOKENS = ['const', ' ', 'a', ' = 1;'];

describe('source positions', () => {
  it('round-trips every offset through a position', () => {
    for (let offset = 0; offset <= TEXT.length; offset += 1) {
      expect(offsetAt(TEXT, pointAt(TEXT, offset))).toBe(offset);
    }
  });

  it('counts lines and characters the way a language server does', () => {
    expect(pointAt(TEXT, 0)).toEqual({ line: 0, character: 0 });
    const secondLine = TEXT.indexOf('function');
    expect(pointAt(TEXT, secondLine)).toEqual({ line: 1, character: 0 });
    expect(pointAt(TEXT, secondLine + 9)).toEqual({ line: 1, character: 9 });
    // The trailing newline opens a last, empty line.
    expect(pointAt(TEXT, TEXT.length)).toEqual({ line: 4, character: 0 });
  });

  it('clamps a position into the line it names', () => {
    // A character past the end of a short line stops at that line's end — the
    // offset just before its newline, which is a position a server accepts.
    const lastLine = TEXT.indexOf('}');
    expect(offsetAt(TEXT, { line: 3, character: 99 })).toBe(lastLine + 1);
    // A line past the end is the end of the text.
    expect(offsetAt(TEXT, { line: 99, character: 0 })).toBe(TEXT.length);
    expect(offsetAt(TEXT, { line: -1, character: 0 })).toBe(TEXT.length);
  });

  it('expands to the identifier under a position', () => {
    const at = TEXT.indexOf('return') + 3;
    expect(identifierAt(TEXT, pointAt(TEXT, at))).toEqual({
      start: TEXT.indexOf('return'),
      end: TEXT.indexOf('return') + 6,
    });
    // The `a` after `return ` is its own one-character token.
    const a = TEXT.indexOf('return a') + 7;
    expect(identifierAt(TEXT, pointAt(TEXT, a))).toEqual({ start: a, end: a + 1 });
  });

  it('finds no identifier on punctuation or whitespace', () => {
    expect(identifierAt(TEXT, { line: 0, character: 5 })).toBeUndefined(); // the space
    expect(identifierAt(TEXT, { line: 0, character: 9 })).toBeUndefined(); // `=`
    expect(identifierAt(TEXT, { line: 4, character: 0 })).toBeUndefined(); // empty line
  });

  it('stops an identifier at the start of its line', () => {
    const start = TEXT.indexOf('const');
    expect(identifierAt(TEXT, pointAt(TEXT, start))).toEqual({ start, end: start + 5 });
  });
});

describe('mapping a DOM position to the source', () => {
  it('adds up the text of every span before the pointer', () => {
    const root = dom(TOKENS);
    const first = root.querySelectorAll('span')[0].firstChild as Text;
    const third = root.querySelectorAll('span')[2].firstChild as Text;
    expect(sourceOffsetIn(root, first, 2)).toBe(2);
    // `a` sits at offset 6; one character in is offset 7.
    expect(sourceOffsetIn(root, third, 1)).toBe(7);
  });

  it('counts an element position as the text of the children before it', () => {
    const root = dom(TOKENS);
    expect(sourceOffsetIn(root, root, 2)).toBe(6);
  });

  it('refuses a node the code element does not hold', () => {
    const root = dom(['a']);
    const other = dom(['b']);
    expect(sourceOffsetIn(root, other.firstChild as Text, 0)).toBeUndefined();
  });

  it('builds a range that measures exactly the named characters', () => {
    const root = dom(TOKENS);
    expect(domRangeFor(root, 0, 5)?.toString()).toBe('const');
    expect(domRangeFor(root, 6, 7)?.toString()).toBe('a');
    expect(domRangeFor(root, 8, 12)?.toString()).toBe('= 1;');
  });

  it('puts a range at the end when the offset is past the text', () => {
    const root = dom(['ab']);
    expect(domRangeFor(root, 2, 9)?.toString()).toBe('');
  });
});
