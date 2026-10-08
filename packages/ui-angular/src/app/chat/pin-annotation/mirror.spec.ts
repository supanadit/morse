import { describe, expect, it } from 'vitest';
import { renderAnnotationMirror } from './mirror';

/**
 * Every character the mirror laid out, tags removed and entities decoded — what
 * the reader's caret is actually moving over. It must be the source, exactly:
 * that equality is the alignment guarantee the whole overlay rests on.
 */
function laidOut(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

describe('renderAnnotationMirror', () => {
  it('lays out every character of the source, marks included', () => {
    const source = [
      '# Range notes',
      '',
      'The `AgentWidget` shape is **fixed by pi** and *not* ours to change,',
      'see [the docs](https://example.com/x) — keep ~~both~~ fields.',
      '',
      '- keep the key',
      '1. keep the lines',
      '',
      '> why: the RPC mode is the contract',
      '',
      '```ts',
      'key: **not bold**',
      '```',
    ].join('\n');

    expect(laidOut(renderAnnotationMirror(source))).toBe(source);
  });

  it('renders bold in place with its markers kept, but unpainted', () => {
    const html = renderAnnotationMirror('**fixed by pi**');
    expect(html).toContain('<span class="b">fixed by pi</span>');
    expect(html.match(/class="mk"/g)).toHaveLength(2);
    expect(laidOut(html)).toBe('**fixed by pi**');
  });

  it('tells bold, italic and strike apart', () => {
    expect(renderAnnotationMirror('**b**')).toContain('class="b"');
    expect(renderAnnotationMirror('*i*')).toContain('class="i"');
    expect(renderAnnotationMirror('_i_')).toContain('class="i"');
    expect(renderAnnotationMirror('__b__')).toContain('class="b"');
    expect(renderAnnotationMirror('~~s~~')).toContain('class="s"');
  });

  it('leaves inline code literal', () => {
    const html = renderAnnotationMirror('`*not italic*`');
    expect(html).toContain('<span class="code">*not italic*</span>');
    expect(html).not.toContain('class="i"');
  });

  it('hides a heading marker and styles the line', () => {
    const html = renderAnnotationMirror('## Why here');
    expect(html).toContain('<span class="h">Why here</span>');
    expect(html).toContain('<span class="mk">## </span>');
  });

  it('keeps list and quote markers visible, but muted', () => {
    expect(renderAnnotationMirror('- keep the key')).toContain('<span class="lm">- </span>');
    expect(renderAnnotationMirror('1. keep the lines')).toContain('<span class="lm">1. </span>');
    expect(renderAnnotationMirror('> why')).toContain('<span class="lm">&gt; </span>');
  });

  it('renders a fenced block literally, with the fences hidden', () => {
    const html = renderAnnotationMirror(['```ts', 'const a = *b*;', '```'].join('\n'));
    expect(html).toContain('<span class="fn">const a = *b*;</span>');
    expect(html).not.toContain('class="i"');
    // Both fences are hidden, so the block reads as one region.
    expect(html.match(/class="mk"/g)).toHaveLength(2);
  });

  it('styles a link on its text and keeps the target unpainted', () => {
    const html = renderAnnotationMirror('[the docs](https://example.com)');
    expect(html).toContain('<span class="link">the docs</span>');
    expect(laidOut(html)).toBe('[the docs](https://example.com)');
  });

  it('escapes markup instead of rendering it', () => {
    const html = renderAnnotationMirror('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(laidOut(html)).toBe('<img src=x onerror=alert(1)>');
  });

  it('is empty for an empty draft', () => {
    expect(renderAnnotationMirror('')).toBe('');
  });
});
