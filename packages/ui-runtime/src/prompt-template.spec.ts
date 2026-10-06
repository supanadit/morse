import { describe, expect, it } from 'vitest';
import {
  composePromptTemplate,
  parseCommandArgs,
  promptTemplateArgumentFields,
  promptTemplateFields,
  promptTemplateForm,
  readPromptTemplate,
  substituteArgs,
} from './prompt-template.js';

/** pi's own example from docs/prompt-templates.md, expanded the way the TUI does. */
const REVIEW = `---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on \${1:-correctness, security, and error handling}.`;

describe('parseCommandArgs', () => {
  it('splits on whitespace, including newlines', () => {
    expect(parseCommandArgs('one two\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('keeps a quoted phrase as one argument', () => {
    expect(parseCommandArgs('"API compatibility" and more')).toEqual([
      'API compatibility',
      'and',
      'more',
    ]);
  });

  it('handles single quotes', () => {
    expect(parseCommandArgs("'two words' three")).toEqual(['two words', 'three']);
  });

  it('is empty for an empty string', () => {
    expect(parseCommandArgs('')).toEqual([]);
    expect(parseCommandArgs('   ')).toEqual([]);
  });
});

describe('substituteArgs', () => {
  it('fills positional placeholders', () => {
    expect(substituteArgs('a $1 b $2', ['one', 'two'])).toBe('a one b two');
  });

  it('falls back to the default when an argument is missing or empty', () => {
    expect(substituteArgs('${1:-fallback}', [])).toBe('fallback');
    expect(substituteArgs('${1:-fallback}', [''])).toBe('fallback');
    expect(substituteArgs('${1:-fallback}', ['set'])).toBe('set');
  });

  it('joins every argument for $@ / $ARGUMENTS', () => {
    expect(substituteArgs('$@', ['a', 'b'])).toBe('a b');
    expect(substituteArgs('$ARGUMENTS', ['a', 'b'])).toBe('a b');
    expect(substituteArgs('${@:-none}', [])).toBe('none');
  });

  it('slices catch-all arguments', () => {
    expect(substituteArgs('${@:2}', ['a', 'b', 'c'])).toBe('b c');
    expect(substituteArgs('${@:2:1}', ['a', 'b', 'c'])).toBe('b');
    // Bash convention: index 0 means the first argument.
    expect(substituteArgs('${@:0}', ['a', 'b'])).toBe('a b');
  });

  it('leaves an unreferenced argument out of the result', () => {
    // The load-bearing correction: pi does not append extra arguments.
    expect(substituteArgs('Review: $1', ['one', 'two', 'three'])).toBe('Review: one');
  });

  it('does not substitute inside a value', () => {
    expect(substituteArgs('$1', ['$2'])).toBe('$2');
  });
});

describe('readPromptTemplate', () => {
  it('reads the hint and strips the frontmatter from the body', () => {
    const parsed = readPromptTemplate(REVIEW);
    expect(parsed.argumentHint).toBe('[focus]');
    expect(parsed.body.startsWith('Review the staged changes.')).toBe(true);
    expect(parsed.body).not.toContain('description:');
  });

  it('treats a file with no frontmatter as body only', () => {
    expect(readPromptTemplate('Just a prompt')).toEqual({ body: 'Just a prompt' });
  });

  it('unquotes a quoted hint', () => {
    expect(readPromptTemplate('---\nargument-hint: "<path>"\n---\nbody').argumentHint).toBe('<path>');
  });
});

describe('promptTemplateForm', () => {
  it('derives fields from the argument hint, marking angle brackets required', () => {
    const form = promptTemplateForm(REVIEW);
    expect(form?.arguments).toEqual([
      {
        id: 'arg1',
        label: 'focus',
        required: false,
        index: 1,
        default: 'correctness, security, and error handling',
      },
    ]);
    expect(form?.body).toContain('Review the staged changes.');
  });

  it('derives fields from the body when there is no hint', () => {
    const form = promptTemplateForm('Fix $1 and $2');
    expect(form?.arguments.map((argument) => argument.index)).toEqual([1, 2]);
    expect(form?.arguments.every((argument) => argument.required === false)).toBe(true);
  });

  it('offers one raw-arguments field for a catch-all-only template', () => {
    const form = promptTemplateForm('Run the tests for $@');
    expect(form?.arguments).toEqual([{ id: 'arguments', label: 'Arguments', required: false }]);
  });

  it('is undefined for a template that takes no arguments', () => {
    expect(promptTemplateForm('Explain this repository')).toBeUndefined();
  });

  it('prefers the hint over the body placeholders', () => {
    const raw = '---\nargument-hint: "<a> [b]"\n---\nUse ${1:-x} and $2';
    const form = promptTemplateForm(raw);
    expect(form?.arguments).toEqual([
      { id: 'arg1', label: 'a', required: true, index: 1, default: 'x' },
      { id: 'arg2', label: 'b', required: false, index: 2 },
    ]);
  });
});

describe('promptTemplateFields', () => {
  it('carries the catch-all default a body declares', () => {
    expect(promptTemplateFields('Summarize ${@:-the whole repo}')).toEqual([
      { id: 'arguments', label: 'Arguments', required: false, default: 'the whole repo' },
    ]);
  });

  it('is empty for a template that takes no arguments', () => {
    expect(promptTemplateFields('Explain this repository')).toEqual([]);
  });
});

describe('promptTemplateArgumentFields', () => {
  it('tracks the body: only referenced placeholders get a field', () => {
    const fields = promptTemplateArgumentFields('Use $1 and $3', '<a> [b] [c]');

    expect(fields).toEqual([
      { id: 'arg1', label: 'a', required: true, index: 1 },
      { id: 'arg3', label: 'c', required: false, index: 3 },
    ]);
  });

  it('drops the field when its placeholder leaves the body', () => {
    expect(promptTemplateArgumentFields('Use $1 only', '<a> [b] [c]')).toEqual([
      { id: 'arg1', label: 'a', required: true, index: 1 },
    ]);
  });

  it('keeps the default a placeholder declares', () => {
    expect(promptTemplateArgumentFields('$1 ${2:-none}')).toEqual([
      { id: 'arg1', label: 'Argument 1', required: false, index: 1 },
      { id: 'arg2', label: 'Argument 2', required: false, index: 2, default: 'none' },
    ]);
  });

  it('is empty for a template that takes no arguments', () => {
    expect(promptTemplateArgumentFields('Explain this repository')).toEqual([]);
  });

  it('offers one raw-arguments field for a catch-all-only body', () => {
    expect(promptTemplateArgumentFields('Run: $@')).toEqual([
      { id: 'arguments', label: 'Arguments', required: false },
    ]);
  });
});

describe('composePromptTemplate', () => {
  it('substitutes the field values into the body', () => {
    const form = promptTemplateForm(REVIEW)!;
    expect(composePromptTemplate(form, { arg1: 'concurrency' })).toBe(
      'Review the staged changes. Focus on concurrency.',
    );
  });

  it('uses the template default for a blank optional field', () => {
    const form = promptTemplateForm(REVIEW)!;
    expect(composePromptTemplate(form, { arg1: '  ' })).toBe(
      'Review the staged changes. Focus on correctness, security, and error handling.',
    );
  });

  it('appends extra instructions below a blank line', () => {
    const form = promptTemplateForm(REVIEW)!;
    expect(composePromptTemplate(form, { arg1: 'concurrency' }, 'Also check the API.')).toBe(
      'Review the staged changes. Focus on concurrency.\n\nAlso check the API.',
    );
  });

  it('appends nothing for whitespace-only extra', () => {
    const form = promptTemplateForm(REVIEW)!;
    expect(composePromptTemplate(form, { arg1: 'concurrency' }, '   ')).toBe(
      'Review the staged changes. Focus on concurrency.',
    );
  });

  it('shell-parses the raw-arguments field for a catch-all template', () => {
    const form = promptTemplateForm('Run: $@')!;
    expect(composePromptTemplate(form, { arguments: '"api tests" lint' })).toBe('Run: api tests lint');
  });
});
