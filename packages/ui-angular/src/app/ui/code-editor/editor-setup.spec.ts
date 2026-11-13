import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, foldable } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { bracketDecorations, editorExtensions, enclosingDeclarations } from './editor-setup';

/** A state with a JavaScript grammar and a fully parsed tree. */
async function jsState(doc: string): Promise<EditorState> {
  const { javascript } = await import('@codemirror/lang-javascript');
  const state = EditorState.create({ doc, extensions: [javascript(), editorExtensions()] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

describe('editorExtensions', () => {
  it('builds a state without a view', () => {
    const state = EditorState.create({ doc: 'const a = 1;\n', extensions: editorExtensions() });
    expect(state.doc.lines).toBe(2);
  });
  it('is read-only', () => {
    const state = EditorState.create({ doc: 'x', extensions: editorExtensions() });
    expect(state.readOnly).toBe(true);
  });
  it('builds a syntax tree for a JavaScript document', async () => {
    const state = await jsState('function a() {\n  return 1;\n}\n');
    expect(ensureSyntaxTree(state, state.doc.length, 5000)).not.toBeNull();
  });
  it('offers a fold range for a function body', async () => {
    const state = await jsState('function a() {\n  return 1;\n}\n');
    const first = state.doc.line(1);
    expect(foldable(state, first.from, first.to)).not.toBeNull();
  });
  it('finds the declaration enclosing a line', async () => {
    const state = await jsState('function a() {\n  return 1;\n}\n');
    expect(enclosingDeclarations(state, 2)).toEqual([{ number: 1, text: 'function a() {' }]);
  });
  it('has no declaration to pin above the first line', async () => {
    const state = await jsState('function a() {\n  return 1;\n}\n');
    expect(enclosingDeclarations(state, 1)).toEqual([]);
  });
  it('tints code brackets and leaves the ones inside strings alone', async () => {
    const doc = 'const s = "{";\nconst o = { a: 1 };\n';
    const state = await jsState(doc);
    const tinted = new Set<number>();
    bracketDecorations(state).between(0, state.doc.length, (from) => {
      tinted.add(from);
    });
    expect(tinted.has(doc.indexOf('{ a'))).toBe(true);
    expect(tinted.has(doc.indexOf('"{"') + 1)).toBe(false);
  });
});
