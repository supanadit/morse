import { describe, expect, it } from 'vitest';
import { userMessageMarkdown } from '../chat/transcript-rows';
import { renderMarkdown, renderUserMarkdown } from './markdown';

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
});
