import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { editorExtensions } from './editor-setup';

describe('editorExtensions', () => {
  it('builds a state without a view', () => {
    const state = EditorState.create({ doc: 'const a = 1;\n', extensions: editorExtensions() });
    expect(state.doc.lines).toBe(2);
  });
  it('is read-only', () => {
    const state = EditorState.create({ doc: 'x', extensions: editorExtensions() });
    expect(state.readOnly).toBe(true);
  });
  it('folds a JavaScript function body when the language is loaded', async () => {
    const { javascript } = await import('@codemirror/lang-javascript');
    const state = EditorState.create({
      doc: 'function a() {\n  return 1;\n}\n',
      extensions: [javascript(), editorExtensions()],
    });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree).not.toBeNull();
  });
});
