/**
 * Syntax colours for the file editor, mapped onto Morse's own tokens so a file
 * tab and a transcript code block agree on what a keyword looks like.
 *
 * Ported from openidea `src/editor/core/cm/highlight.ts` @ 835c446
 * (Apache-2.0) — see NOTICE. The tag set is narrower on purpose: no doc-comment
 * sub-tags, no log-warning tag, no VCS insert/delete colours, because this
 * editor has no language server and no diff lane.
 */
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** Every custom property the style reads; a spec checks each one exists. */
export const THEME_TOKENS = [
  '--morse-keyword',
  '--morse-string',
  '--morse-number',
  '--morse-typename',
  '--morse-info',
  '--morse-comment',
  '--morse-punct',
  '--morse-fg',
  '--morse-error',
] as const;

export const morseHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.bool,
      t.null,
      t.unit,
      t.tagName,
      t.angleBracket,
      t.annotation,
      t.macroName,
      t.processingInstruction,
    ],
    color: 'var(--morse-keyword)',
  },
  {
    tag: [t.heading],
    color: 'var(--morse-keyword)',
    fontWeight: '600',
  },
  {
    tag: [t.string, t.special(t.string), t.character, t.attributeValue, t.regexp, t.escape],
    color: 'var(--morse-string)',
  },
  {
    tag: [t.number, t.integer, t.float, t.atom, t.constant(t.variableName), t.labelName],
    color: 'var(--morse-number)',
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.standard(t.typeName)],
    color: 'var(--morse-typename)',
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
      t.function(t.definition(t.variableName)),
      t.standard(t.function(t.variableName)),
      t.url,
    ],
    color: 'var(--morse-info)',
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote],
    color: 'var(--morse-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [t.punctuation, t.bracket, t.separator, t.operator, t.derefOperator, t.meta],
    color: 'var(--morse-punct)',
  },
  {
    tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.definition(t.propertyName)],
    color: 'var(--morse-fg)',
  },
  { tag: [t.invalid], color: 'var(--morse-error)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
]);
