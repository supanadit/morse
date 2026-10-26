import { describe, expect, it } from 'vitest';
import { decorateMarkdown, decoratedMarkdownHtml, type MarkdownDecorSpan } from './decorate';

/** The text a decorated HTML rendering holds, entities and tags undone. */
function undecorated(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function kinds(spans: MarkdownDecorSpan[]): string[] {
  return spans.map((span) => span.kind);
}

describe('decorateMarkdown', () => {
  it('spans a fenced block: fence lines as fence, content as highlighted code', () => {
    const text = 'before\n```json\n{"a": 1}\n```\nafter';
    const spans = decorateMarkdown(text);

    expect(kinds(spans)).toEqual(['fence', 'code', 'fence']);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('```json');
    expect(text.slice(spans[1].start, spans[1].end)).toBe('{"a": 1}\n');
    expect(text.slice(spans[2].start, spans[2].end)).toBe('```');
    // The code span carries syntax coloring over exactly its own characters.
    expect(undecorated(spans[1].html ?? '')).toBe('{"a": 1}\n');
    expect(spans[1].html).not.toBe('{"a": 1}\n');
  });

  it('decorates an unterminated fence to the end of the draft, closing at the closing line', () => {
    const text = '```json\n{"a": 1}';
    const open = decorateMarkdown(text);
    expect(kinds(open)).toEqual(['fence', 'code']);
    expect(open[1].end).toBe(text.length);

    const closed = decorateMarkdown(`${text}\n\`\`\`\ntail`);
    const code = closed.find((span) => span.kind === 'code');
    // The panel ends where the closing fence begins — not at the end of the draft.
    expect(code?.end).toBe(text.length + 1);
  });

  it('decorates inline code, strong and em', () => {
    const text = 'run `npm test` with **care** and *style*';
    const spans = decorateMarkdown(text);

    expect(kinds(spans)).toEqual(['inline-code', 'strong', 'em']);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('`npm test`');
    expect(text.slice(spans[1].start, spans[1].end)).toBe('**care**');
    expect(text.slice(spans[2].start, spans[2].end)).toBe('*style*');
  });

  it('decorates an unclosed opener to the end of the draft', () => {
    const text = 'look `code and **bold';
    const spans = decorateMarkdown(text);
    const code = spans.find((span) => span.kind === 'inline-code');

    expect(text.slice(code?.start ?? 0, code?.end ?? 0)).toBe('`code and **bold');
  });

  it('leaves `5 * 3` and `snake_case` alone (flanking, not emphasis)', () => {
    expect(kinds(decorateMarkdown('5 * 3 = 15'))).toEqual([]);
    expect(kinds(decorateMarkdown('snake_case_name'))).toEqual([]);
    expect(kinds(decorateMarkdown('5 * 3 * 5'))).toEqual([]);
  });

  it('decorates links, and bracketed non-links stay plain', () => {
    const text = 'see [the docs](https://x) and arr[0]';
    const spans = decorateMarkdown(text);

    expect(kinds(spans)).toEqual(['link']);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('[the docs](https://x)');
  });

  it('decorates an unclosed bracket to the end of the draft', () => {
    const text = 'see [the docs';
    const spans = decorateMarkdown(text);
    expect(kinds(spans)).toEqual(['link']);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('[the docs');
  });

  it('headings take the whole line, list markers only the bullet', () => {
    const text = '# Title\n- **item**';
    const spans = decorateMarkdown(text);

    expect(kinds(spans)).toEqual(['heading', 'list', 'strong']);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('# Title');
    expect(text.slice(spans[1].start, spans[1].end)).toBe('- ');
    expect(text.slice(spans[2].start, spans[2].end)).toBe('**item**');
  });

  it('never overlaps, never empties, and stays ordered', () => {
    const text = ['# H', '', '```js', 'const x = 1;', '```', '', '- `a` **b** [c](d)', 'tail'].join(
      '\n',
    );
    let at = -1;
    for (const span of decorateMarkdown(text)) {
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.start).toBeGreaterThanOrEqual(at);
      at = span.end;
    }
  });

  it('decorated HTML holds the exact characters of the source', () => {
    const text = [
      '# Title',
      'Some **bold** text with `code` and [a link](https://x).',
      '```json',
      '{"a": 1, "b": "<tag> & more"}',
      '```',
      '- item *one*',
      'tail of draft `unclosed',
    ].join('\n');

    expect(undecorated(decoratedMarkdownHtml(text))).toBe(text);
    expect(decoratedMarkdownHtml('')).toBe('');
    expect(undecorated(decoratedMarkdownHtml('<&"'))).toBe('<&"');
  });

  it('decorates a ~50 KB worst-case draft inside one frame budget', () => {
    const unit = [
      '## Section',
      'Prose with **bold**, *em*, `inline` and [a link](https://example.com).',
      '```ts',
      'const answer: number = 42;',
      '```',
      '- item one',
      '- item two',
      '',
    ].join('\n');
    const draft = unit.repeat(Math.ceil(50_000 / unit.length));
    expect(draft.length).toBeGreaterThanOrEqual(50_000);

    // The composer paints this per frame (see markdown-paint.spec.ts): a
    // quadratic scan once cost 160 ms for this draft; the two-pointer pass
    // measures ~11 ms alone, ~35 ms with the suite's parallel spec files on
    // the box. 100 ms is noise-tolerant and still fails the quadratic code.
    const started = performance.now();
    const html = decoratedMarkdownHtml(draft);
    const elapsed = performance.now() - started;
    expect(undecorated(html)).toBe(draft);
    expect(elapsed).toBeLessThan(100);
    process.stdout.write(
      `\n[decorate] 50 KB draft scanned and rendered in ${elapsed.toFixed(2)} ms\n`,
    );
  });
});
