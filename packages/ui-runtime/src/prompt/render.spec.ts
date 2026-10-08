import { describe, expect, it } from 'vitest';
import { readPromptTemplate } from '../prompt-template.js';
import { renderPromptTemplate } from './render.js';

describe('renderPromptTemplate', () => {
  it('writes frontmatter then the body', () => {
    expect(
      renderPromptTemplate({
        description: 'Review staged git changes',
        argumentHint: '[focus]',
        body: 'Review the staged changes.',
      }),
    ).toBe(
      '---\ndescription: Review staged git changes\nargument-hint: "[focus]"\n---\nReview the staged changes.\n',
    );
  });

  it('quotes a value that would break YAML', () => {
    const raw = renderPromptTemplate({ description: 'Review: staged changes', body: 'body' });
    expect(raw).toContain('description: "Review: staged changes"');
    // Round-trips through the same frontmatter reader the editor lists with.
    expect(readPromptTemplate(raw).argumentHint).toBeUndefined();
  });

  it('omits the frontmatter entirely when neither field is set', () => {
    expect(renderPromptTemplate({ body: 'Just a prompt' })).toBe('Just a prompt\n');
  });
});
