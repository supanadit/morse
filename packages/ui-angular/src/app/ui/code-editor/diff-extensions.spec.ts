import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import { parseUnifiedDiff } from '@morse/ui-runtime';
import {
  documentText,
  splitDocuments,
  unifiedDocument,
  type DiffDocument,
} from './diff-document';
import { diffExtensions, type DiffSide } from './diff-extensions';
import { editorExtensions } from './editor-setup';
import type { EditorPin } from './pins';

/**
 * The diff surface is a CodeMirror view, so these specs mount one: `editor-setup.spec`
 * already proves jsdom can, and what is worth asserting here is the DOM a reader sees —
 * the two number columns, the signs, the tinted rows and the hunk captions. The click
 * gesture itself needs hit-testing (`posAtCoords`), which jsdom has no layout for; its
 * arithmetic (`blockPinned`) is covered in `diff-document.spec.ts`.
 */
const DIFF = '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n';

/** A mounted diff view, cleaned up by the caller. */
function open(document_: DiffDocument, side: DiffSide, pins: readonly EditorPin[] = []): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: documentText(document_),
      extensions: [
        editorExtensions({ gutters: false, sticky: false }),
        diffExtensions({ document: document_, side, pins, onPin: vi.fn() }),
      ],
    }),
  });
}

describe('a unified diff view', () => {
  it('numbers both files in their own columns', () => {
    const view = open(unifiedDocument(parseUnifiedDiff(DIFF)), 'both');
    const old = view.dom.querySelector('.morse-diff-gutter-old');
    const fresh = view.dom.querySelector('.morse-diff-gutter-new');

    // The deletion has no new-file number; the two additions have no old one.
    expect(old?.textContent).toBe('12');
    expect(fresh?.textContent).toBe('123');
    view.destroy();
  });

  it('signs the added and removed rows', () => {
    const view = open(unifiedDocument(parseUnifiedDiff(DIFF)), 'both');
    const signs = view.dom.querySelector('.morse-diff-gutter-sign');

    expect(signs?.textContent).toContain('+');
    expect(signs?.textContent).toContain('−');
    view.destroy();
  });

  it('draws the hunk header as a caption above its rows, not as a row', () => {
    const document_ = unifiedDocument(parseUnifiedDiff(DIFF));
    const view = open(document_, 'both');

    // Four rows of file content, one caption: the header gets no line number, no
    // pin and no place in a copied range.
    expect(view.state.doc.lines).toBe(4);
    expect(view.dom.querySelector('.morse-diff-hunk')?.textContent).toBe('@@ -1,2 +1,3 @@');
    view.destroy();
  });

  it('tints the added and removed rows', () => {
    const view = open(unifiedDocument(parseUnifiedDiff(DIFF)), 'both');

    expect(view.dom.querySelectorAll('.morse-diff-add')).toHaveLength(2);
    expect(view.dom.querySelectorAll('.morse-diff-del')).toHaveLength(1);
    expect(view.dom.querySelectorAll('.morse-diff-pinned')).toHaveLength(0);
    // The numbers share the row's tint — three gutters (old, new, sign) per row — so a
    // changed line reads as one band instead of a number rail and a distant line.
    expect(view.dom.querySelectorAll('.cm-gutterElement.morse-diff-row-add')).toHaveLength(6);
    expect(view.dom.querySelectorAll('.cm-gutterElement.morse-diff-row-del')).toHaveLength(3);
    view.destroy();
  });

  it('tints a pinned block and stops offering the click', () => {
    const view = open(unifiedDocument(parseUnifiedDiff(DIFF)), 'both', [
      // The two additions are new-file lines 2 and 3.
      { id: 'p1', startLine: 2, endLine: 3 },
    ]);

    // The deletion shares the anchor of the additions beside it, so it is covered too.
    expect(view.dom.querySelectorAll('.morse-diff-pinned')).toHaveLength(3);
    // …and its numbers say so, in all three gutters.
    expect(view.dom.querySelectorAll('.cm-gutterElement.morse-diff-row-pinned')).toHaveLength(9);
    expect(view.dom.querySelectorAll('.cm-gutterElement.morse-diff-row-add')).toHaveLength(0);
    // The highlight is not a control: nothing in the block invites a click.
    expect(view.dom.querySelectorAll('.morse-diff-clickable')).toHaveLength(0);
    view.destroy();
  });

  it('offers the click on an unpinned change block', () => {
    const view = open(unifiedDocument(parseUnifiedDiff(DIFF)), 'both');

    expect(view.dom.querySelectorAll('.morse-diff-clickable')).toHaveLength(3);
    view.destroy();
  });
});

describe('a side-by-side diff view', () => {
  it('gives each side its own file’s numbers, and pads the short one', () => {
    const { left, right } = splitDocuments(parseUnifiedDiff(DIFF));
    const oldSide = open(left, 'old');
    const newSide = open(right, 'new');

    // Old lines 1 and 2, then a blank row for the addition's own row.
    expect(oldSide.dom.querySelector('.morse-diff-gutter-old')?.textContent).toBe('12');
    expect(newSide.dom.querySelector('.morse-diff-gutter-new')?.textContent).toBe('123');
    // A side shows one file's numbers and the sign column, never both files'.
    expect(oldSide.dom.querySelector('.morse-diff-gutter-new')).toBeNull();
    expect(newSide.dom.querySelector('.morse-diff-gutter-old')).toBeNull();
    expect(oldSide.state.doc.lines).toBe(newSide.state.doc.lines);
    oldSide.destroy();
    newSide.destroy();
  });
});
