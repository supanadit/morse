/**
 * Turning a pointer on the rendered source into the position a language server
 * understands, and back again.
 *
 * The preview draws one `<pre><code>` of highlighted HTML, so a DOM position is
 * not a source position: highlight.js splits the text into spans and escapes it,
 * which the browser reverses on parse. Two conversions bridge that:
 *
 * - **DOM -> source**: walk the text nodes under the code element and add up
 *   their lengths (`sourceOffsetIn`). The result is an offset into the same
 *   string the host read, because the only transformation between them was
 *   entity escaping, which the DOM has already undone.
 * - **source -> DOM**: find the text node an offset falls in and build a `Range`
 *   (`domRangeFor`), so diagnostics and the jump target can be measured with
 *   `getClientRects()` instead of guessed from a character width.
 *
 * The text half (`pointAt` / `offsetAt` / `identifierAt`) is plain string math on
 * purpose: it is what the unit tests can pin down, and it is the part that has to
 * be exact for a language server to answer about the right token.
 */

/** A zero-based position in the source, LSP's own frame. */
export interface SourcePoint {
  line: number;
  character: number;
}

/** Half-open, in flat offsets. */
export interface SourceSpan {
  start: number;
  end: number;
}

/** What an identifier looks like: the token a hover or a jump acts on. */
const IDENTIFIER = /[\p{L}\p{N}_$]/u;

/** Whether a character is part of an identifier (an absent one never is). */
function isIdentifier(character: string | undefined): boolean {
  return character !== undefined && character.length > 0 && IDENTIFIER.test(character);
}

/**
 * The flat offset a position names, clamped into the line it points at: a
 * `character` past the line's end stops just before its newline, which is a
 * position a language server accepts (and what the offset round-trip relies on).
 */
export function offsetAt(text: string, point: SourcePoint): number {
  const start = startOfLine(text, point.line);
  if (start === undefined) {
    return text.length;
  }
  const end = endOfLine(text, start);
  return Math.min(start + Math.max(0, point.character), end);
}

/**
 * The position a flat offset names. An offset past the end of the text lands at
 * the text's end instead of throwing — the UI computes offsets from the DOM, and
 * a stale measurement must not break a request.
 */
export function pointAt(text: string, offset: number): SourcePoint {
  const limit = Math.min(Math.max(0, offset), text.length);
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < limit; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: limit - lineStart };
}

/**
 * The identifier around a position, or `undefined` when the pointer is on
 * punctuation or whitespace. Expansion stays inside the line: a language server
 * answers "nothing here" for a position in the middle of a newline, and a span
 * across two lines is never one token.
 */
export function identifierAt(text: string, point: SourcePoint): SourceSpan | undefined {
  const offset = offsetAt(text, point);
  const lineStart = startOfLine(text, point.line) ?? 0;
  const lineEnd = endOfLine(text, lineStart);
  // The pointer names the gap *before* a character. A gap whose own character is
  // not part of a token has no token under it: expanding backwards from a space
  // would otherwise answer about the word the pointer has just left.
  if (!isIdentifier(text[offset])) {
    return undefined;
  }
  let start = offset;
  let end = offset;
  while (start > lineStart && isIdentifier(text[start - 1])) {
    start -= 1;
  }
  while (end < lineEnd && isIdentifier(text[end])) {
    end += 1;
  }
  // Expansion stays inside the line: a span across two lines is never one token.
  return { start, end };
}

/**
 * The flat offset a DOM position maps to, by adding up every text node before
 * it. `node` may be an element (with `offsetInNode` counting its children), which
 * is what `caretPositionFromPoint` hands back when the point is between spans.
 */
export function sourceOffsetIn(root: Node, node: Node, offsetInNode: number): number | undefined {
  if (!root.contains(node)) {
    return undefined;
  }
  let total = 0;
  let found = false;
  const visit = (current: Node): void => {
    if (found) {
      return;
    }
    if (current === node) {
      // A text node contributes its own offset; an element contributes the text
      // of the children before `offsetInNode`.
      if (current.nodeType === Node.TEXT_NODE) {
        total += offsetInNode;
      } else {
        for (let index = 0; index < offsetInNode && index < current.childNodes.length; index += 1) {
          total += textLength(current.childNodes[index]);
        }
      }
      found = true;
      return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      total += (current.textContent ?? '').length;
      return;
    }
    for (const child of current.childNodes) {
      visit(child);
      if (found) {
        return;
      }
    }
  };
  visit(root);
  return found ? total : undefined;
}

/** A `Range` covering `[start, end)` of the source, for measuring. */
export function domRangeFor(root: Node, start: number, end: number): Range | undefined {
  const from = locate(root, start);
  const to = locate(root, end);
  if (from === undefined || to === undefined) {
    return undefined;
  }
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** The text node and offset a flat source offset falls in. */
function locate(root: Node, offset: number): { node: Node; offset: number } | undefined {
  let remaining = offset;
  let last: { node: Node; offset: number } | undefined;
  const walk = (node: Node): { node: Node; offset: number } | undefined => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child.textContent ?? '').length;
        if (remaining <= length) {
          return { node: child, offset: remaining };
        }
        remaining -= length;
        last = { node: child, offset: length };
        continue;
      }
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(root) ?? last;
}

function textLength(node: Node): number {
  return (node.textContent ?? '').length;
}

/** The offset a line's first character sits at, or `undefined` past the end. */
function startOfLine(text: string, line: number): number | undefined {
  if (line < 0) {
    return undefined;
  }
  let current = 0;
  let start = 0;
  while (current < line) {
    const next = text.indexOf('\n', start);
    if (next < 0) {
      return undefined;
    }
    start = next + 1;
    current += 1;
  }
  return start;
}

/** The offset a line ends at (its newline, or the end of the text). */
function endOfLine(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline < 0 ? text.length : newline;
}
