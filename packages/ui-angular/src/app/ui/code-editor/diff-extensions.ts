/**
 * A diff, drawn by the same CodeMirror the file view uses.
 *
 * Everything the two hand-rolled diff tables used to do in Angular markup is here,
 * in the editor that already owns the code surface: the old/new gutters, the sign
 * column, the added/removed tints, the hunk headers, and the "click a change block
 * to pin it" gesture. The stylesheet is `code-editor.css`, so a change to how code
 * looks reaches a file and a diff in one edit — which is the whole point.
 *
 * The document (and what each line means) comes from `diff-document.ts`; this module
 * only reads it. A split side is one of these, so the side-by-side view is two
 * editors of identical length, not a second renderer.
 */
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  type BlockInfo,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { blockPinned, changePinned, EMPTY_DIFF, type DiffDocument, type DiffLine } from './diff-document';
import type { EditorPin } from './pins';
import type { PinRequest } from './pin-selection';

/** Which side of the change a view draws. */
export type DiffSide = 'old' | 'new' | 'both';

/** The document a diff view is drawing: one facet, read by the gutters and clicks. */
const diffDocument = Facet.define<DiffDocument, DiffDocument>({
  combine: (values) => values[0] ?? EMPTY_DIFF,
});

/** The pins this file has, so the tints know which blocks are already recorded. */
const diffPins = StateField.define<readonly EditorPin[]>({
  create: () => [],
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setDiffPins)) {
        return effect.value;
      }
    }
    return value;
  },
});

/** Replace the pins the diff tints read; the component sends these on every change. */
export const setDiffPins = StateEffect.define<readonly EditorPin[]>();

/** The sign column's glyphs; a context line keeps its space so the column holds. */
const SIGNS: Record<DiffLine['kind'], string> = {
  add: '+',
  del: '−',
  context: ' ',
  blank: ' ',
};

// --- line tints ------------------------------------------------------------

const lineDecorations = new Map<string, Decoration>();

/** One line decoration per class string, cached: CM compares them by identity. */
function lineDecoration(classes: string): Decoration {
  let decoration = lineDecorations.get(classes);
  if (decoration === undefined) {
    decoration = Decoration.line({ class: classes });
    lineDecorations.set(classes, decoration);
  }
  return decoration;
}

/** The classes a document line carries: what it is, whether it is pinned, clickable. */
function classesFor(line: DiffLine | undefined, pins: readonly EditorPin[]): string {
  if (line === undefined) {
    return '';
  }
  const classes = [`morse-diff-line`, `morse-diff-${line.kind}`];
  if (line.change !== undefined && !blockPinned(pins, line.change)) {
    classes.push('morse-diff-clickable');
  }
  if (changePinned(pins, line.newAnchor)) {
    classes.push('morse-diff-pinned');
  }
  return classes.join(' ');
}

function tints(state: EditorState): DecorationSet {
  const document = state.facet(diffDocument);
  const pins = state.field(diffPins);
  const ranges: Range<Decoration>[] = [];
  for (let index = 0; index < document.lines.length; index += 1) {
    const classes = classesFor(document.lines[index], pins);
    if (classes.length > 0) {
      ranges.push(lineDecoration(classes).range(state.doc.line(index + 1).from));
    }
  }
  return Decoration.set(ranges, true);
}

/** Paints every diff line's role; recomputed when the pins move. */
const diffTints = StateField.define<DecorationSet>({
  // The pins field is initialized first (it comes first in `diffExtensions`), so the
  // tints a view opens with are the ones its document deserves.
  create: (state) => tints(state),
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setDiffPins)) {
        return tints(transaction.state);
      }
    }
    return transaction.docChanged ? tints(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// --- hunk headers ----------------------------------------------------------

/**
 * A hunk's `@@ … @@` header.
 *
 * It is not a line of either file, so it is a block widget above the line it
 * introduces: no line number, no pin, nothing to select into a copied range.
 */
class HunkHeader extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: HunkHeader): boolean {
    return other.text === this.text;
  }
  override toDOM(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'morse-diff-hunk';
    header.textContent = this.text;
    return header;
  }
  /** The header is a caption, not a control. */
  override ignoreEvent(): boolean {
    return true;
  }
}

function hunkWidgets(state: EditorState): DecorationSet {
  const document = state.facet(diffDocument);
  const ranges: Range<Decoration>[] = [];
  for (const hunk of document.hunks) {
    const line = Math.min(hunk.line + 1, state.doc.lines);
    ranges.push(
      Decoration.widget({
        block: true,
        side: -1,
        widget: new HunkHeader(hunk.text),
      }).range(state.doc.line(line).from),
    );
  }
  return Decoration.set(ranges, true);
}

const diffHunks = StateField.define<DecorationSet>({
  create: (state) => hunkWidgets(state),
  update: (value, transaction) =>
    transaction.docChanged ? hunkWidgets(transaction.state) : value,
  provide: (field) => EditorView.decorations.from(field),
});

// --- gutters ---------------------------------------------------------------

/** The line a gutter element is being built for, through the document facet. */
function lineAt(view: EditorView, block: BlockInfo): DiffLine | undefined {
  const index = view.state.doc.lineAt(block.from).number - 1;
  return view.state.facet(diffDocument).lines[index];
}

/** One gutter cell's text; a new marker per measure, but `eq` keeps the DOM still. */
class Cell extends GutterMarker {
  override readonly elementClass: string;
  constructor(
    readonly text: string,
    readonly className: string,
    elementClass: string,
  ) {
    super();
    this.elementClass = elementClass;
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof Cell &&
      other.text === this.text &&
      other.className === this.className &&
      other.elementClass === this.elementClass
    );
  }
  override toDOM(): Node {
    const element = document.createElement('span');
    element.className = this.className;
    element.textContent = this.text;
    return element;
  }
}

/** A blank cell of fixed width, so a gutter's width never jumps between files. */
class Spacer extends GutterMarker {
  constructor(
    readonly className: string,
    readonly width: number,
  ) {
    super();
  }
  override toDOM(): Node {
    const element = document.createElement('span');
    element.className = this.className;
    element.style.display = 'inline-block';
    element.style.width = `${this.width}px`;
    return element;
  }
}

function numberMarker(
  side: 'old' | 'new',
): (view: EditorView, block: BlockInfo) => GutterMarker | null {
  return (view, block) => {
    const line = lineAt(view, block);
    const number = side === 'old' ? line?.oldLine : line?.newLine;
    return new Cell(
      number === undefined ? '' : String(number),
      'morse-diff-num',
      gutterRowClass(line, view.state.field(diffPins)),
    );
  };
}

function signMarker(view: EditorView, block: BlockInfo): GutterMarker | null {
  const line = lineAt(view, block);
  const sign = line === undefined ? SIGNS.blank : SIGNS[line.kind];
  const className =
    line?.kind === 'add' || line?.kind === 'del'
      ? `morse-diff-sign morse-diff-sign-${line.kind}`
      : 'morse-diff-sign';
  return new Cell(sign, className, gutterRowClass(line, view.state.field(diffPins)));
}

/**
 * The tint a gutter cell shares with its row.
 *
 * A diff row is one band: the numbers and the sign belong to the line, so they carry
 * its tint. Leaving them neutral read as a gap between the numbers and the code.
 */
function gutterRowClass(line: DiffLine | undefined, pins: readonly EditorPin[]): string {
  if (line === undefined || line.kind === 'blank') {
    return '';
  }
  if (changePinned(pins, line.newAnchor)) {
    return 'morse-diff-row-pinned';
  }
  return line.kind === 'context' ? '' : `morse-diff-row-${line.kind}`;
}

/** Re-read the markers when the pins move, so a band's gutter tints with it. */
function pinnedMarkers(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) =>
    transaction.effects.some((effect) => effect.is(setDiffPins)),
  );
}

function numbers(side: 'old' | 'new'): Extension {
  return gutter({
    class: `morse-diff-gutter morse-diff-gutter-${side}`,
    lineMarker: numberMarker(side),
    lineMarkerChange: pinnedMarkers,
    initialSpacer: () => new Spacer('morse-diff-num', side === 'old' ? 24 : 26),
  });
}

/** The sign column: `+`, `−`, or a space, exactly where the old view put it. */
const signs: Extension = gutter({
  class: 'morse-diff-gutter morse-diff-gutter-sign',
  lineMarker: signMarker,
  lineMarkerChange: pinnedMarkers,
  initialSpacer: () => new Spacer('morse-diff-sign', 10),
});

/** The number columns a side shows: the old file's, the new file's, or both. */
function gutters(side: DiffSide): Extension {
  if (side === 'old') {
    return [numbers('old'), signs];
  }
  if (side === 'new') {
    return [numbers('new'), signs];
  }
  return [numbers('old'), numbers('new'), signs];
}

// --- the gesture -----------------------------------------------------------

/**
 * Clicking a change block pins its new-file range to the next prompt.
 *
 * A block a pin already covers is left alone: the tint is not a control, and the
 * band's own `Cancel` is the way to unpin — the same rule the file view's band
 * follows. A drag (a selection) is not a click, so copying a diff line still works.
 */
function clickToPin(onPin: (request: PinRequest) => void): Extension {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      if (!view.state.selection.main.empty) {
        return false;
      }
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) {
        return false;
      }
      const line = view.state.facet(diffDocument).lines[view.state.doc.lineAt(position).number - 1];
      const change = line?.change;
      if (change === undefined || blockPinned(view.state.field(diffPins), change)) {
        return false;
      }
      onPin(
        change.end > change.start
          ? { startLine: change.start, endLine: change.end }
          : { startLine: change.start },
      );
      return true;
    },
  });
}

// --- the set ---------------------------------------------------------------

export interface DiffExtensionsOptions {
  readonly document: DiffDocument;
  readonly side: DiffSide;
  /** The pins the tints start with; later changes arrive through `repinDiff`. */
  readonly pins: readonly EditorPin[];
  /** A click on an unpinned change block. */
  readonly onPin: (request: PinRequest) => void;
}

/** Everything a diff view adds to the shared editor: its document, gutters, tints. */
export function diffExtensions(options: DiffExtensionsOptions): Extension {
  return [
    diffDocument.of(options.document),
    diffPins.init(() => options.pins),
    diffTints,
    diffHunks,
    gutters(options.side),
    clickToPin(options.onPin),
  ];
}

/** Send the pins the tints and the click gesture read. */
export function repinDiff(view: EditorView, pins: readonly EditorPin[]): void {
  view.dispatch({ effects: setDiffPins.of(pins) });
}
