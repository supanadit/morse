// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { userMessageMarkdown } from '../transcript/rows.js';
import { renderMarkdown, renderUserMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('renders a fenced block with its language and a copy button', () => {
    const html = renderMarkdown('```bash\necho hi\n```');
    expect(html).toContain('class="code"');
    expect(html).toContain('>bash<');
    expect(html).toContain('data-copy');
  });

  it('strips script markup from untrusted text', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script');
  });

  it('links a bare URL pasted without a scheme', () => {
    const html = renderMarkdown('lihat github.com/owner/repo dulu');
    expect(html).toContain('<a href="https://github.com/owner/repo"');
    expect(html).toContain('target="_blank"');
  });

  it('leaves filenames and version numbers as plain text', () => {
    expect(renderMarkdown('file main.ts')).not.toContain('<a ');
    expect(renderMarkdown('versi 1.2.3')).not.toContain('<a ');
  });
});

describe('renderUserMarkdown', () => {
  it('keeps the mention chip and the code block side by side', () => {
    const html = renderUserMarkdown(userMessageMarkdown('lihat @README.md\n\n```bash\nmorse start\n```'));
    expect(html).toContain('data-mention-path="README.md"');
    expect(html).toContain('class="mention-label"');
    expect(html).toContain('class="code"');
    expect(html).toContain('morse start');
  });

  it('preserves the single line breaks a prompt was typed with', () => {
    expect(renderUserMarkdown(userMessageMarkdown('baris satu\nbaris dua'))).toContain('<br>');
  });

  it('links a bare URL in a prompt next to a mention chip', () => {
    const html = renderUserMarkdown(userMessageMarkdown('cek github.com/owner/repo @README.md'));
    expect(html).toContain('<a href="https://github.com/owner/repo"');
    expect(html).toContain('data-mention-path="README.md"');
  });
});
