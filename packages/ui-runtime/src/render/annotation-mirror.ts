/**
 * The annotation editor's mirror: the markdown being written, rendered *in place*
 * so `**bold**` reads as **bold** the moment the closing stars are typed.
 *
 * Why a mirror and not a rich editor: the value the user writes has to stay
 * markdown on the wire (the prompt carries `  > ` lines of it), so the source
 * must never be rewritten to HTML. Instead the textarea stays the single input —
 * its text made transparent — and this renders underneath it, in the same font,
 * on the same grid.
 *
 * That is what the hidden syntax marks are for: every character of the source is
 * emitted, but the ones that only exist to carry meaning (`**`, a heading's `#`,
 * the tail of a link) are wrapped in `.mk`, which the stylesheet hides with
 * `visibility: hidden` rather than `display: none`. Hidden keeps their advance
 * width, so the caret in the textarea still sits on the character it is editing.
 * Markers a reader needs to see — a list bullet, an ordered number, a quote's
 * `>` — are emitted visibly instead (`.lm`), muted.
 *
 * The editor's stylesheet therefore has two obligations this function relies on:
 * a monospace font (bold and italic monospace glyphs share an advance width, so
 * styling cannot shift the grid) and a line-height that does not change per line
 * (headings are emphasised, never resized).
 */

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
/**
 * One pass over a line's inline markdown, alternatives in precedence order, so a
 * rule can never re-read the marks an earlier rule just emitted (the bug a chain
 * of `.replace()` calls has: the italic rule happily matched the `**` inside the
 * bold rule's own hidden span). Groups are read positionally below.
 */
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\[([^\]]+)\]\(([^)]+)\)|\*([^*\n]+)\*|_([^_\n]+)_/g;

/**
 * A block marker a line may lead with. `hide` collapses it visually (the styling
 * says what it was); `show` keeps it readable like the markdown the user typed.
 */
interface LineRule {
  pattern: RegExp;
  /** The class the line's content gets. */
  content: string;
  /** Whether the marker itself stays visible. */
  marker: 'hide' | 'show';
}

const LINE_RULES: readonly LineRule[] = [
  { pattern: /^(#{1,6}\s+)/, content: 'h', marker: 'hide' },
  { pattern: /^(>\s?)/, content: 'q', marker: 'show' },
  { pattern: /^(\s*(?:[-+*]|\d+[.)])\s+)/, content: 'li', marker: 'show' },
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A syntax mark the mirror keeps in the layout but does not paint. */
function mark(text: string): string {
  return `<span class="mk">${escapeHtml(text)}</span>`;
}

/** A marker the reader still needs to see: muted, not hidden. */
function marker(text: string): string {
  return `<span class="lm">${escapeHtml(text)}</span>`;
}

/**
 * One line's inline markdown, in a single pass over the **raw** text: plain runs
 * are escaped as they are emitted, and each rule escapes its own payload, so the
 * result is safe by construction and no rule can see another's markup.
 */
function inline(text: string): string {
  let out = '';
  let last = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    out += escapeHtml(text.slice(last, match.index));
    const [, code, bold, boldAlt, strike, linkText, linkHref, italic, italicAlt] = match;
    if (code !== undefined) {
      out += `${mark('`')}<span class="code">${escapeHtml(code)}</span>${mark('`')}`;
    } else if (bold !== undefined) {
      out += wrap('**', 'b', bold);
    } else if (boldAlt !== undefined) {
      out += wrap('__', 'b', boldAlt);
    } else if (strike !== undefined) {
      out += wrap('~~', 's', strike);
    } else if (linkText !== undefined) {
      // The target is kept for the layout but not painted: the reader sees a link.
      out += `<span class="mk">[</span><span class="link">${escapeHtml(linkText)}</span><span class="mk">](${escapeHtml(linkHref ?? '')})</span>`;
    } else if (italic !== undefined) {
      out += wrap('*', 'i', italic);
    } else if (italicAlt !== undefined) {
      out += wrap('_', 'i', italicAlt);
    }
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** A styled run with its syntax marks kept (unpainted) on both sides. */
function wrap(marker: string, className: string, content: string): string {
  return `${mark(marker)}<span class="${className}">${escapeHtml(content)}</span>${mark(marker)}`;
}

/** One line outside a fence: its block marker, then its inline markdown. */
function blockLine(line: string): string {
  for (const rule of LINE_RULES) {
    const match = rule.pattern.exec(line);
    if (match === null) {
      continue;
    }
    const lead = match[1] ?? '';
    const body = inline(line.slice(match[0].length));
    const leadHtml = rule.marker === 'hide' ? mark(lead) : marker(lead);
    return `${leadHtml}<span class="${rule.content}">${body}</span>`;
  }
  return inline(line);
}

/**
 * The whole draft as mirror HTML: one span per line, `\n`-joined so `<pre>` lays
 * it out identically to the textarea over it. A fenced block's contents are
 * literal (no inline rules) — code is code — and its fences are hidden, so the
 * block reads as one tinted region.
 */
export function renderAnnotationMirror(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const open = FENCE_LINE.exec(line);
    if (open !== null) {
      const char = (open[1] ?? '').charAt(0);
      if (fence === undefined) {
        fence = char;
        out.push(mark(line));
        continue;
      }
      if (char === fence) {
        fence = undefined;
        out.push(mark(line));
        continue;
      }
    }
    if (fence !== undefined) {
      out.push(`<span class="fn">${escapeHtml(line)}</span>`);
      continue;
    }
    out.push(blockLine(line));
  }
  return out.join('\n');
}
