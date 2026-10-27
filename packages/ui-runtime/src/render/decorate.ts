import { escapeHtml, highlightCode } from './highlight.js';

/**
 * The markdown a composer paints while it is typed. Every span is a range over
 * the verbatim source: the scanner decorates text, it never rewrites it, so a
 * painted layer stays character-identical to the buffer it mirrors.
 */
export type MarkdownDecorKind =
  | 'fence'
  | 'hide'
  | 'block'
  | 'code'
  | 'inline-code'
  | 'strong'
  | 'em'
  | 'link'
  | 'heading'
  | 'list';

export interface MarkdownDecorSpan {
  start: number;
  end: number;
  kind: MarkdownDecorKind;
  /**
   * For `code`: highlighted HTML over exactly [start, end). highlight.js wraps
   * the same characters in spans and never alters them, which is what keeps a
   * painted code block line-identical to its source.
   */
  html?: string;
  /**
   * For `block`: language identifier from the opening fence (e.g. 'ts', 'json').
   */
  lang?: string;
}

export interface DecorateOptions {
  viewMode?: boolean;
  /** Caret/selection range [start, end) to gate block vs source presentation */
  selection?: [number, number];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const LIST_MARKER = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)/;
const WORD_CHAR = /[A-Za-z0-9]/;

function isSelectionInside(
  blockStart: number,
  blockEnd: number,
  selection: [number, number] | undefined,
): boolean {
  if (!selection) {
    return false;
  }
  const [start, end] = selection;
  if (start === end) {
    return start >= blockStart && start <= blockEnd;
  }
  return start < blockEnd && end > blockStart;
}

/**
 * Finds the markdown constructs worth decorating in a draft and returns them as
 * non-overlapping, ordered spans over the source text:
 *
 * - fenced code blocks: the marker lines are `fence`, the content between them
 *   is one `code` span with syntax-highlighted HTML; an unclosed fence runs to
 *   the end of the draft, and closing it ends the block at the closing line;
 * - inline code, strong/emphasis and links; an unclosed opener runs to the end
 *   of the draft (or to the next block construct) so the formatting is visible
 *   while the construct is still being typed;
 * - heading lines (whole line) and list markers (the bullet/number only, so the
 *   rest of the line still gets inline formatting).
 *
 * Delimiters follow the spirit of CommonMark's flanking rules: `5 * 3` and
 * `snake_case` are punctuation, not emphasis. Closed inline pairs are matched
 * within a line; a closer on a later line reads as "unclosed" and decorates to
 * the end of the draft — a decoration nicety only, the text is never touched.
 */
export function decorateMarkdown(text: string, options?: DecorateOptions): MarkdownDecorSpan[] {
  const spans: MarkdownDecorSpan[] = [];
  /** Regions the inline pass must not re-decorate (code, headings, markers). */
  const blocked: Array<[number, number]> = [];
  let offset = 0;
  let fence: {
    marker: string;
    blockStart: number;
    openSpanIndex: number;
    contentStart: number;
    lang: string;
  } | undefined;
  const viewMode = options?.viewMode ?? false;

  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd);
    if (fence !== undefined) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        pushCode(spans, blocked, text, fence, offset);
        const inside = isSelectionInside(fence.blockStart, lineEnd, options?.selection);
        const isPanel = viewMode && !inside;
        // Update opening span kind based on inside/outside gating
        spans[fence.openSpanIndex].kind = isPanel ? 'block' : 'fence';
        spans.push({ start: offset, end: lineEnd, kind: isPanel ? 'hide' : 'fence' });
        blocked.push([offset, lineEnd]);
        fence = undefined;
      }
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        const lang = open[2] || undefined;
        const openSpanIndex = spans.length;
        spans.push({
          start: offset,
          end: lineEnd,
          kind: viewMode ? 'block' : 'fence',
          ...(lang ? { lang } : {}),
        });
        blocked.push([offset, lineEnd]);
        fence = {
          marker: open[1],
          blockStart: offset,
          openSpanIndex,
          contentStart: Math.min(lineEnd + 1, text.length),
          lang: open[2],
        };
      } else if (HEADING.test(line)) {
        spans.push({ start: offset, end: lineEnd, kind: 'heading' });
        blocked.push([offset, lineEnd]);
      } else {
        const marker = LIST_MARKER.exec(line);
        if (marker) {
          spans.push({ start: offset, end: offset + marker[0].length, kind: 'list' });
          blocked.push([offset, offset + marker[0].length]);
        }
      }
    }
    offset = lineEnd + 1;
  }
  if (fence !== undefined) {
    pushCode(spans, blocked, text, fence, text.length);
    const inside = isSelectionInside(fence.blockStart, text.length, options?.selection);
    const isPanel = viewMode && !inside;
    spans[fence.openSpanIndex].kind = isPanel ? 'block' : 'fence';
  }

  // Built in forward scan order: sorted and disjoint, so one moving gate walks
  // it. The inline pass is O(n + b); a per-character search here was O(n·b) and
  // cost 160 ms on a 50 KB draft (the perf test in markdown-paint.spec.ts).
  let gate = 0;
  let at = 0;
  while (at < text.length) {
    while (gate < blocked.length && blocked[gate][1] <= at) {
      gate += 1;
    }
    const inside = blocked[gate];
    if (inside !== undefined && at >= inside[0]) {
      at = inside[1];
      continue;
    }
    const span = inlineAt(text, at, inside === undefined ? text.length : inside[0]);
    if (span) {
      spans.push(span);
      at = span.end;
      continue;
    }
    at += 1;
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * The HTML a mirror paints for `text`: the verbatim characters, escaped, each
 * decoration wrapped in a span. `stripTags(html)` returns `text` exactly — that
 * is the geometry contract the composer's paint layer depends on.
 */
export function decoratedMarkdownHtml(text: string, options?: DecorateOptions): string {
  let html = '';
  let at = 0;
  for (const span of decorateMarkdown(text, options)) {
    if (span.start > at) {
      html += escapeHtml(text.slice(at, span.start));
    }
    const body =
      span.kind === 'code' && span.html !== undefined
        ? span.html
        : escapeHtml(text.slice(span.start, span.end));
    const extra = span.kind === 'block' && span.lang ? ` data-lang="${escapeHtml(span.lang)}"` : '';
    html += `<span class="md-${span.kind}"${extra}>${body}</span>`;
    at = span.end;
  }
  if (at < text.length) {
    html += escapeHtml(text.slice(at));
  }
  return html;
}

/** Adds the fenced content as one highlighted span, skipping an empty block. */
function pushCode(
  spans: MarkdownDecorSpan[],
  blocked: Array<[number, number]>,
  text: string,
  fence: { contentStart: number; lang: string },
  end: number,
): void {
  if (end <= fence.contentStart) {
    return;
  }
  const body = text.slice(fence.contentStart, end);
  spans.push({ start: fence.contentStart, end, kind: 'code', html: highlightCode(body, fence.lang).html });
  // Code content is its own decoration: the inline pass must not reach inside
  // it (a `*em*` line in a fenced block used to get double-decorated, which
  // duplicated the text and drifted every wrapped line under the caret).
  blocked.push([fence.contentStart, end]);
}

/** One inline construct starting at `at`, or undefined when this is plain text. */
function inlineAt(text: string, at: number, limit: number): MarkdownDecorSpan | undefined {
  const end = Math.min(limit, text.length);
  const char = text[at];
  if (char === '`') {
    const close = text.indexOf('`', at + 1);
    return close !== -1 && close < end
      ? { start: at, end: close + 1, kind: 'inline-code' }
      : { start: at, end, kind: 'inline-code' };
  }
  const two = text.slice(at, at + 2);
  if (two === '**' || two === '__') {
    return delimSpan(text, at, 2, end, two, 'strong');
  }
  if (char === '*' || char === '_') {
    // Flanking: a delimiter next to whitespace (`5 * 3`) or inside a word
    // (`snake_case`) is punctuation, not emphasis.
    const after = text[at + 1] ?? '';
    if (after === '' || /\s/.test(after)) {
      return undefined;
    }
    if (char === '_' && WORD_CHAR.test(text[at - 1] ?? '')) {
      return undefined;
    }
    return delimSpan(text, at, 1, end, char, 'em');
  }
  if (char === '[') {
    // Links never span lines; slicing the whole remainder here made pasted
    // drafts quadratic.
    const newline = text.indexOf('\n', at);
    const line = text.slice(at, newline === -1 || newline > end ? end : newline);
    const link = /^\[[^\]\n]*\]\([^)\n]*\)/.exec(line);
    if (link) {
      return { start: at, end: at + link[0].length, kind: 'link' };
    }
    const close = text.indexOf(']', at);
    return close === -1 || close >= end ? { start: at, end, kind: 'link' } : undefined;
  }
  return undefined;
}

/** A strong/em span, closed at the next well-flanked delimiter or open to `end`. */
function delimSpan(
  text: string,
  at: number,
  width: number,
  end: number,
  delim: string,
  kind: 'strong' | 'em',
): MarkdownDecorSpan | undefined {
  let search = at + width;
  while (search < end) {
    const close = text.indexOf(delim, search);
    if (close === -1 || close + width > end) {
      break;
    }
    const before = text[close - 1] ?? '';
    const after = text[close + width] ?? '';
    const wellFlanked =
      before !== '' &&
      !/\s/.test(before) &&
      (delim !== '_' || !WORD_CHAR.test(after));
    if (wellFlanked) {
      return { start: at, end: close + width, kind };
    }
    search = close + width;
  }
  return { start: at, end, kind };
}
