/**
 * The extension set of the read-only file editor: the comfort behaviours ported
 * from openidea, minus everything that edits, completes or diagnoses.
 *
 * Ported from openidea `src/editor/core/cm/{prefs,stickyScroll,indentGuides,
 * rainbowBrackets}.ts` @ 835c446 (Apache-2.0) — see NOTICE. What is deliberately
 * absent from those ports: multi-caret, column mode, overwrite, smart keys,
 * completion, rendered doc comments, code lens, VCS lanes, relative numbers.
 */
import type { Extension } from '@codemirror/state';
import { EditorState, StateField, type Range } from '@codemirror/state';
import { foldGutter, foldKeymap, syntaxTree, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  scrollPastEnd,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { morseHighlightStyle } from './editor-theme';

/** The brace tints, cycled by depth (index 0 is depth 1). */
const BRACKET_TINTS = 5;

/** How many declarations stay pinned while scrolling. */
const STICKY_MAX = 2;

export interface EditorSetupOptions {
  /** Sticky scrolled declarations on (default) or off. */
  readonly sticky?: boolean;
  /** Soft wrap on (default) or off. */
  readonly wrap?: boolean;
}

// --- caret row -------------------------------------------------------------

const caretRowDecoration = Decoration.line({ class: 'morse-caret-row' });

function caretRows(view: EditorView): DecorationSet {
  const out = [];
  let last = -1;
  for (const range of view.state.selection.ranges) {
    const from = view.lineBlockAt(range.head).from;
    if (from > last) {
      out.push(caretRowDecoration.range(from));
    }
    last = from;
  }
  return Decoration.set(out, true);
}

/** The tint under every caret's row; it paints beneath the selection layer. */
export const caretRow = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = caretRows(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.geometryChanged) {
        this.decorations = caretRows(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// --- smooth caret ----------------------------------------------------------

function onScreen(view: EditorView, position: number): boolean {
  const coords = view.coordsAtPos(position);
  if (coords === null) {
    return false;
  }
  const box = view.scrollDOM.getBoundingClientRect();
  return coords.top >= box.top && coords.bottom <= box.bottom;
}

/**
 * Smooth caret movement: the cursor layer reuses its elements, so a CSS
 * transition on their position animates a move. Only a selection-only update
 * glides; typing, layout changes and moves that scroll land at once.
 */
const caretGlide = ViewPlugin.fromClass(
  class {
    on = false;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      const from = update.startState.selection;
      const to = update.state.selection;
      if (
        !update.selectionSet ||
        update.docChanged ||
        update.geometryChanged ||
        from.ranges.length !== to.ranges.length
      ) {
        this.set(false);
        return;
      }
      // Measured before the editor scrolls the new caret into view.
      update.view.requestMeasure({
        key: this,
        read: (view) => onScreen(view, from.main.head) && onScreen(view, to.main.head),
        write: (on) => this.set(on),
      });
    }
    set(on: boolean) {
      if (on === this.on) {
        return;
      }
      this.on = on;
      this.view.scrollDOM
        .querySelector(':scope > .cm-cursorLayer')
        ?.classList.toggle('morse-caret-glide', on);
    }
  },
);

// --- indent guides ---------------------------------------------------------

const guideDecorations = new Map<number, Decoration>();

function guide(depth: number): Decoration {
  let decoration = guideDecorations.get(depth);
  if (decoration === undefined) {
    decoration = Decoration.line({
      class: 'morse-guides',
      attributes: { style: `--morse-guides-depth:${depth}` },
    });
    guideDecorations.set(depth, decoration);
  }
  return decoration;
}

function guides(view: EditorView): DecorationSet {
  const out = [];
  const unit = Math.max(1, view.state.tabSize);
  for (const { from, to } of view.visibleRanges) {
    let position = from;
    while (position <= to) {
      const line = view.state.doc.lineAt(position);
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? '';
      const depth = indent.includes('\t') ? indent.length : Math.floor(indent.length / unit);
      if (depth > 0) {
        out.push(guide(depth).range(line.from));
      }
      position = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

/** One hairline per indent level, from the line's leading whitespace. */
const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = guides(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = guides(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// --- rainbow brackets ------------------------------------------------------

const bracketMarks = Array.from({ length: BRACKET_TINTS }, (_, index) =>
  Decoration.mark({ class: `morse-bracket-${index + 1}` }),
);

const OPENERS = '([{';
const CLOSERS = ')]}';
/** A bracket inside one of these is text, not structure. */
const LITERAL_NODE = /comment|string|regexp|template|character|quote/i;

/**
 * Bracket tints for the whole document, computed once from the syntax tree.
 *
 * The tree is what keeps a `{` inside a string or a comment plain, and scanning
 * the document in order (rather than per visible range) is what keeps a
 * bracket's colour from changing as the viewport scrolls.
 */
export function bracketDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  let depth = 0;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.to - node.from !== 1) {
        return;
      }
      const parent = node.node.parent;
      if (parent !== null && LITERAL_NODE.test(parent.name)) {
        return;
      }
      const char = state.sliceDoc(node.from, node.to);
      if (OPENERS.includes(char)) {
        out.push(bracketMarks[depth % BRACKET_TINTS]!.range(node.from, node.to));
        depth += 1;
      } else if (CLOSERS.includes(char)) {
        depth = Math.max(0, depth - 1);
        out.push(bracketMarks[depth % BRACKET_TINTS]!.range(node.from, node.to));
      }
    },
  });
  return Decoration.set(out, true);
}

/** Brackets tinted by nesting depth, so a deep expression reads at a glance. */
const rainbowBrackets = StateField.define<DecorationSet>({
  create: (state) => bracketDecorations(state),
  update: (value, transaction) => (transaction.docChanged ? bracketDecorations(transaction.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

// --- sticky scrolled declarations ------------------------------------------

export interface StickyLine {
  readonly number: number;
  readonly text: string;
}

/**
 * The declarations enclosing a line, innermost first, capped at `STICKY_MAX`.
 * Pure over the state so it can be tested without a view; the plugin below adds
 * only the "which line is at the top" measurement.
 */
export function enclosingDeclarations(state: EditorState, lineNumber: number): StickyLine[] {
  const line = state.doc.line(Math.min(Math.max(1, lineNumber), state.doc.lines));
  if (line.number <= 1) {
    return [];
  }
  const out: StickyLine[] = [];
  let node = syntaxTree(state).resolveInner(line.from, 1);
  for (; node !== null; node = node.parent as typeof node) {
    if (node.name === 'Program' || node.name === 'Document' || node.to <= line.from) {
      continue;
    }
    const start = state.doc.lineAt(node.from);
    // A block starts on the same line as its declaration; one band, not two.
    if (start.number < line.number && out.every((seen) => seen.number !== start.number)) {
      out.push({ number: start.number, text: start.text });
    }
  }
  return out.slice(0, STICKY_MAX).reverse();
}

/** The enclosing declarations of the line at the top of the viewport. */
function stickyLines(view: EditorView): StickyLine[] {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  return enclosingDeclarations(view.state, view.state.doc.lineAt(block.from).number);
}

/** The pinned band: enclosing declarations stay at the top while their body scrolls. */
const stickyScroll = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLElement;
    constructor(readonly view: EditorView) {
      this.dom = document.createElement('div');
      this.dom.className = 'morse-sticky';
      this.dom.setAttribute('aria-hidden', 'true');
      view.dom.appendChild(this.dom);
      this.measure(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.measure(update.view);
      }
    }
    measure(view: EditorView) {
      view.requestMeasure({
        key: this,
        read: (current) => stickyLines(current),
        write: (lines) => this.paint(lines),
      });
    }
    paint(lines: readonly StickyLine[]) {
      if (lines.length === 0) {
        this.dom.replaceChildren();
        this.dom.style.display = 'none';
        return;
      }
      this.dom.style.display = '';
      // The numbers column grows with the file's digit count; the band's copy of it
      // has to line up with the gutter it covers, so it takes the measured width
      // (the stylesheet's floor is only the four-digit case).
      const numbers = this.dom.parentElement?.querySelector('.cm-lineNumbers');
      if (numbers !== null && numbers !== undefined) {
        this.dom.style.setProperty(
          '--morse-number-width',
          `${Math.round(numbers.getBoundingClientRect().width)}px`,
        );
      }
      this.dom.replaceChildren(
        ...lines.map((line) => {
          const row = document.createElement('div');
          row.className = 'morse-sticky-line';
          const number = document.createElement('span');
          number.className = 'morse-sticky-number';
          number.textContent = String(line.number);
          const text = document.createElement('span');
          text.className = 'morse-sticky-text';
          text.textContent = line.text;
          row.append(number, text);
          return row;
        }),
      );
    }
    destroy() {
      this.dom.remove();
    }
  },
);

// --- the set ---------------------------------------------------------------

/** The whole read-only editor, minus the document and its language. */
export function editorExtensions(options: EditorSetupOptions = {}): Extension {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    options.wrap === false ? [] : EditorView.lineWrapping,
    syntaxHighlighting(morseHighlightStyle),
    drawSelection({ cursorBlinkRate: 1200 }),
    caretGlide,
    caretRow,
    highlightActiveLineGutter(),
    // The numbers are not decoration: dragging them pins whole lines (see
    // `CodeEditor.startGutterDrag`), which needs this gutter to exist.
    lineNumbers(),
    foldGutter(),
    keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]),
    search({ top: true }),
    scrollPastEnd(),
    options.sticky === false ? [] : stickyScroll,
    indentGuides,
    rainbowBrackets,
    EditorView.contentAttributes.of({
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
    }),
  ];
}
