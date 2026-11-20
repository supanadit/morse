/**
 * The code surface: a file's text, or its changes.
 *
 * One component draws both. A diff used to be a second renderer — plain Angular
 * tables with highlight.js output injected as HTML — which meant every change to how
 * code looks, selects, searches or is pinned had to be made twice, and the two drifted.
 * Here a diff is just another document in the same CodeMirror: its own gutters (old
 * number, new number, sign), its own tints, its hunk headers as block widgets, and the
 * same `morse-pin-actions` band pairs over it.
 *
 * The document is created once and then follows the inputs: `text` replaces the file's
 * document, `mode`/`diff` rebuild it as a diff (a side-by-side diff is two views of the
 * same length, scroll-synced), `path` swaps the grammar (each grammar is its own lazy
 * chunk), `line` reveals and flashes, `pins` feeds the tints and the band pairs.
 * Nothing here edits a document — this is a reader, and the product has no write path.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { foldedRanges, type LanguageSupport } from '@codemirror/language';
import { parseUnifiedDiff, pinRangeLabel, type PopoverAnchor } from '@morse/ui-runtime';
import type { DiffView } from '../../state/display-prefs';
import { pinAtLine } from './bands';
import {
  bandCandidates,
  documentText,
  revealDocLine,
  splitDocuments,
  unifiedDocument,
  type DiffDocument,
} from './diff-document';
import { diffExtensions, repinDiff, type DiffSide } from './diff-extensions';
import { editorExtensions } from './editor-setup';
import { loadLanguage } from './languages';
import type { EditorPin } from './pins';
import { pinFromText, type PinRequest } from './pin-selection';
import { clearFlash, flashExtension, revealLine } from './scroll';
import { PinActions } from '../pin-annotation/pin-actions';
import { PinAnnotation, type AnnotationTarget } from '../pin-annotation/pin-annotation';

/** How long a jumped-to line stays lit. */
const FLASH_MS = 900;
/** A pin's note/Cancel pair, floating at the bottom edge of its band. */
interface BandAction {
  readonly pin: EditorPin;
  readonly top: number;
  /** Which pane of a side-by-side diff the band sits in. */
  readonly pane: 'left' | 'right';
}

/** The card whose note is open in the annotation editor. */
interface NoteEditor {
  readonly pin: EditorPin;
  readonly anchor: PopoverAnchor;
}

/** One live editor and the diff side it draws (`undefined` for the file's text). */
interface Surface {
  readonly view: EditorView;
  readonly document: DiffDocument | undefined;
}

/** Replace the pinned ranges' line tints. */
const setPinTints = StateEffect.define<DecorationSet>();

const pinTint = Decoration.line({ class: 'morse-pin-line' });

const pinTintField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPinTints)) {
        return effect.value;
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

@Component({
  selector: 'morse-code-editor',
  templateUrl: './code-editor.html',
  styleUrl: './code-editor.css',
  imports: [PinAnnotation, PinActions],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // CodeMirror builds its own DOM, so emulated encapsulation would never reach
  // it; the stylesheet scopes every selector to the host element instead, and
  // `conventions.spec.ts` holds that line.
  encapsulation: ViewEncapsulation.None,
  host: {
    '[attr.aria-label]': "mode() === 'file' ? 'File ' + path() : 'Changes to ' + path()",
  },
})
export class CodeEditor {
  /** The file's text, as the tab store read it. Only a `file` surface draws it. */
  readonly text = input.required<string>();
  /** The file's path: the grammar's key, and the accessible name. */
  readonly path = input.required<string>();
  /** A 1-based line to reveal and flash (search hits, git jumps, a chip click). */
  readonly line = input<number | undefined>(undefined);
  /** This file's ranges; the editor tints each and floats its note pair on it. */
  readonly pins = input<readonly EditorPin[]>([]);
  /**
   * What this surface is: the file's own text, or its changes in one of the two diff
   * layouts. The same component, the same stylesheet, the same pin gestures.
   */
  readonly mode = input<DiffView>('file');
  /** The file's unified diff, drawn when `mode` is not `file`. */
  readonly diff = input<string | undefined>(undefined);

  readonly pinRequested = output<PinRequest>();
  readonly noteEdited = output<{ id: string; note: string }>();
  readonly unpinned = output<{ id: string }>();
  /**
   * The selection a pin could be made from, or `null`.
   *
   * The affordance itself lives in the file's header, not floating over the code: a
   * pill pinned to the selection's head sat on top of the very lines it was about,
   * and stayed there after the pin was made. A diff has no selection pill: a click
   * on a change block is that surface's one gesture.
   */
  readonly selectionChanged = output<PinRequest | null>();

  private readonly host = viewChild<ElementRef<HTMLElement>>('host');
  /** The right pane, which exists only for a side-by-side diff. */
  private readonly rightHost = viewChild<ElementRef<HTMLElement>>('rightHost');
  private readonly bandTrack = viewChild<ElementRef<HTMLElement>>('bandTrack');
  private readonly language = new Compartment();
  /**
   * Each pin's pair, at the bottom of its band in document coordinates.
   *
   * There is no card column beside the code: the note rides the band's own `Notes`
   * chip, which renders it on hover and opens the annotation editor on a click. A
   * fixed rail spent 240px of every file's reading width to repeat what the chip
   * already holds.
   */
  protected readonly bandActions = signal<readonly BandAction[]>([]);
  /** A pair the reader has just used, so it steps aside instead of sitting there. */
  protected readonly dismissed = signal(false);
  /**
   * The pin whose band the pointer is over: the only one whose pair is on screen.
   *
   * Held by id, not by pin, because the store hands over fresh objects for the same
   * ranges — a note being saved must not re-arm a pair the reader already put away.
   */
  protected readonly hoveredPinId = signal<string | undefined>(undefined);
  /** The range label the band pair and the annotation header both show. */
  protected readonly pinRangeLabel = pinRangeLabel;

  /** The card whose note is being edited, and where the popover points. */
  protected readonly noteEditing = signal<NoteEditor | undefined>(undefined);
  /** What the annotation editor names: this file, and the pin's range. */
  protected readonly noteTarget = computed<AnnotationTarget | undefined>(() => {
    const editing = this.noteEditing();
    return editing === undefined
      ? undefined
      : { path: this.path(), range: pinRangeLabel(editing.pin) };
  });

  /** The file's view, or a diff's new side. The side a pin points at. */
  private mainView: EditorView | undefined;
  /** A side-by-side diff's old side. */
  private leftView: EditorView | undefined;
  /** What `mainView` draws as a diff; `undefined` when it draws the file. */
  private document: DiffDocument | undefined;
  /** What `leftView` draws, in a side-by-side diff. */
  private leftDocument: DiffDocument | undefined;
  /** The mode + diff the live views were built for, so a no-op effect does no work. */
  private shape = '';
  private loadedPath: string | undefined;
  /** The grammar `loadedPath` resolved to, kept so a rebuilt view gets it back. */
  private grammar: LanguageSupport | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last selection reported up, so an unchanged one is not re-emitted. */
  private reportedSelection: string | null = null;
  private readonly onScroll = () => this.syncTrack();
  private readonly onLeftScroll = () => this.syncScroll(this.leftView, this.mainView);
  private readonly onRightScroll = () => this.syncScroll(this.mainView, this.leftView);

  constructor() {
    afterNextRender(() => this.rebuild());
    // The surface follows the mode and the diff text: a different document, not a
    // patch of the current one. A late right pane re-runs this, which is why the
    // hosts are read here.
    effect(() => {
      this.mode();
      this.diff();
      this.host();
      this.rightHost();
      untracked(() => this.rebuild());
    });
    effect(() => {
      const text = this.text();
      untracked(() => this.replaceText(text));
    });
    effect(() => {
      const path = this.path();
      untracked(() => void this.applyLanguage(path));
    });
    effect(() => {
      const line = this.line();
      if (line === undefined) {
        return;
      }
      untracked(() => this.reveal(line));
    });
    effect(() => {
      this.pins();
      untracked(() => this.applyPins());
    });
    // The band track only exists once its markup renders, so the transform is
    // applied from an effect that watches the signals, not from the write that
    // created them.
    effect(() => {
      this.bandActions();
      this.bandTrack();
      untracked(() => this.syncTrack());
    });
    // A pair the reader used comes back only for a different band: moving on (or
    // leaving the code) is what re-arms it, so a click does not leave it floating
    // over the lines it was used on.
    effect(() => {
      this.hoveredPinId();
      untracked(() => this.dismissed.set(false));
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.flashTimer !== undefined) {
        clearTimeout(this.flashTimer);
      }
      this.destroyViews();
    });
  }

  // --- building the surface --------------------------------------------------

  /**
   * Build the view(s) this mode and diff ask for, once.
   *
   * A diff is not a patch of the previous document: line numbering, gutters and the
   * meaning of a line all change, so the state is replaced rather than updated.
   */
  private rebuild(): void {
    const mode = this.mode();
    const diff = this.diff() ?? '';
    const host = this.host()?.nativeElement;
    const rightHost = this.rightHost()?.nativeElement;
    if (host === undefined) {
      return;
    }
    if (mode === 'split' && rightHost === undefined) {
      // The right pane renders with the mode; this runs again when it exists.
      this.shape = '';
      return;
    }
    const shape = `${mode}\u0000${mode === 'file' ? '' : diff}`;
    if (shape === this.shape && this.mainView !== undefined) {
      return;
    }
    this.shape = shape;
    this.destroyViews();
    if (mode === 'file') {
      this.mainView = this.create(host, 'file', this.text(), []);
    } else {
      const parsed = parseUnifiedDiff(diff);
      if (mode === 'split') {
        const { left, right } = splitDocuments(parsed);
        this.document = right;
        this.leftDocument = left;
        this.leftView = this.create(host, 'old', documentText(left), this.diffExtensionsOf(left, 'old'));
        this.mainView = this.create(rightHost!, 'new', documentText(right), this.diffExtensionsOf(right, 'new'));
      } else {
        this.document = unifiedDocument(parsed);
        this.mainView = this.create(host, 'both', documentText(this.document), this.diffExtensionsOf(this.document, 'both'));
      }
    }
    this.applyGrammar();
    this.applyPins();
    const line = this.line();
    if (line !== undefined) {
      this.reveal(line);
    }
  }

  /** The diff's own extensions: gutters, tints, hunk headers, click-to-pin. */
  private diffExtensionsOf(document: DiffDocument, side: DiffSide): Extension[] {
    return [
      diffExtensions({
        document,
        side,
        pins: this.pins(),
        onPin: (request) => this.pinRequested.emit(request),
      }),
    ];
  }

  /**
   * Mount one view.
   *
   * `role` says what it draws: the file's text (which owns the pin tints and the
   * gutter-drag gesture), or one side of a diff (which brings its own).
   */
  private create(host: HTMLElement, role: 'file' | 'both' | 'old' | 'new', doc: string, extra: Extension[]): EditorView {
    const file = role === 'file';
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          editorExtensions({
            // A diff carries its own two number columns and its own sign column.
            gutters: file,
            // Declarations do not survive a hunk boundary, so no sticky band there.
            sticky: file,
            // The two sides of a split are two scrollers: wrapping one would break
            // the row pairing, so a long line scrolls instead.
            wrap: file || role === 'both',
          }),
          flashExtension,
          this.language.of([]),
          ...(file ? [pinTintField] : []),
          EditorView.updateListener.of((update) => {
            if (file && (update.selectionSet || update.docChanged || update.geometryChanged)) {
              this.reportSelection(update.view);
            }
            if (update.docChanged || update.viewportChanged || update.geometryChanged) {
              this.refreshBands();
            }
          }),
          ...(file
            ? [
                EditorView.domEventHandlers({
                  mousedown: (event, current) => this.startGutterDrag(event, current),
                }),
              ]
            : []),
          ...extra,
        ],
      }),
    });
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    view.scrollDOM.addEventListener(
      'scroll',
      role === 'old' ? this.onLeftScroll : this.onRightScroll,
      { passive: true },
    );
    return view;
  }

  /** Every live editor, the side a pin points at first. */
  private surfaces(): Surface[] {
    const surfaces: Surface[] = [];
    if (this.mainView !== undefined) {
      surfaces.push({ view: this.mainView, document: this.document });
    }
    if (this.leftView !== undefined) {
      surfaces.push({ view: this.leftView, document: this.leftDocument });
    }
    return surfaces;
  }

  private destroyViews(): void {
    for (const view of [this.mainView, this.leftView]) {
      if (view === undefined) {
        continue;
      }
      view.scrollDOM.removeEventListener('scroll', this.onScroll);
      view.scrollDOM.removeEventListener('scroll', this.onLeftScroll);
      view.scrollDOM.removeEventListener('scroll', this.onRightScroll);
      view.destroy();
    }
    this.mainView = undefined;
    this.leftView = undefined;
    this.document = undefined;
    this.leftDocument = undefined;
  }

  /** Keep the two sides of a split on the same line. */
  private syncScroll(from: EditorView | undefined, to: EditorView | undefined): void {
    if (from === undefined || to === undefined) {
      return;
    }
    if (Math.abs(to.scrollDOM.scrollTop - from.scrollDOM.scrollTop) < 1) {
      return;
    }
    to.scrollDOM.scrollTop = from.scrollDOM.scrollTop;
  }

  // --- pins ------------------------------------------------------------------

  /** Tint every line a pin covers, and place its card. */
  private applyPins(): void {
    const pins = this.pins();
    if (this.mode() === 'file') {
      const view = this.mainView;
      if (view !== undefined) {
        const doc = view.state.doc;
        const ranges: Range<Decoration>[] = [];
        for (const pin of pins) {
          const first = Math.min(Math.max(1, pin.startLine), doc.lines);
          const last = Math.min(Math.max(first, pin.endLine ?? first), doc.lines);
          for (let number = first; number <= last; number += 1) {
            ranges.push(pinTint.range(doc.line(number).from));
          }
        }
        view.dispatch({ effects: setPinTints.of(Decoration.set(ranges, true)) });
      }
    } else {
      for (const surface of this.surfaces()) {
        repinDiff(surface.view, pins);
      }
    }
    this.refreshBands();
  }

  /**
   * Place each pin's `Notes`/`Cancel` pair on the bottom edge of its band, in document
   * coordinates: the band track is translated by the scroll offset, so a pair moves
   * with its lines and is placed once per measure rather than once per scroll pixel.
   *
   * A diff's band is not a line number but a row: the pin's range is in the new file's
   * line space, and the document maps it back to the row it sits on. A side-by-side
   * diff ranks both sides, so a deletion keeps its pair on the deleted row rather than
   * beside the unchanged line that followed it, and an addition rides the new side.
   */
  private refreshBands(): void {
    const surfaces = this.surfaces();
    const pins = this.pins();
    const bands: BandAction[] = [];
    for (const pin of pins) {
      let best: { surface: Surface; line: number; rank: number } | undefined;
      for (const surface of surfaces) {
        const candidates =
          surface.document === undefined
            ? [{ line: pin.endLine ?? pin.startLine, rank: 0 }]
            : bandCandidates(surface.document, pin);
        for (const candidate of candidates) {
          if (best === undefined || candidate.rank < best.rank) {
            best = { surface, line: candidate.line, rank: candidate.rank };
          }
        }
      }
      if (best === undefined) {
        continue;
      }
      const doc = best.surface.view.state.doc;
      const from = doc.line(Math.min(Math.max(1, best.line), doc.lines)).from;
      const folded = foldedRanges(best.surface.view.state);
      let hidden = false;
      folded.between(from, from, () => {
        hidden = true;
        return false;
      });
      if (!hidden) {
        bands.push({
          pin,
          top: best.surface.view.lineBlockAt(from).bottom,
          // A pair belongs over the pane it describes, not on the far edge of both.
          pane: best.surface.view === this.leftView ? 'left' : 'right',
        });
      }
    }
    this.bandActions.set(bands);
    this.syncTrack();
  }

  /** The line under the pointer, which decides whose pair is on screen. */
  protected trackPointer(event: PointerEvent): void {
    const surface = this.surfaceAt(event.target);
    if (surface === undefined) {
      return;
    }
    const target = event.target;
    // The pair itself sits over a band: hovering it is not hovering the code.
    if (target instanceof Element && target.closest('morse-pin-actions') !== null) {
      return;
    }
    const view = surface.view;
    const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
    const number = view.state.doc.lineAt(block.from).number;
    // A diff row is not a line of the new file: its anchor is.
    const row = surface.document?.lines[number - 1];
    const line = row === undefined ? number : (row.newAnchor ?? row.oldLine ?? number);
    this.hoveredPinId.set(pinAtLine(this.pins(), line)?.id);
  }

  /** Leaving the code — for the pair, a popover or another pane — puts the pairs away. */
  protected clearPointer(): void {
    this.hoveredPinId.set(undefined);
  }

  /** The editor whose DOM holds the event, if any. */
  private surfaceAt(target: EventTarget | null): Surface | undefined {
    if (!(target instanceof Node)) {
      return undefined;
    }
    return this.surfaces().find((surface) => surface.view.dom.contains(target));
  }

  /** Keep the band pairs beside their lines while the editor scrolls. */
  private syncTrack(): void {
    const view = this.mainView;
    if (view === undefined) {
      return;
    }
    const band = this.bandTrack()?.nativeElement;
    if (band !== undefined) {
      band.style.transform = `translateY(${-view.scrollDOM.scrollTop}px)`;
    }
  }

  /** ✎ on a band: open the annotation editor anchored to that button. */
  protected openNote(pin: EditorPin, button: HTMLElement): void {
    // The pair did its job; the range keeps its tint and the chip goes.
    this.dismissed.set(true);
    const rect = button.getBoundingClientRect();
    this.noteEditing.set({
      pin,
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
  }

  /** Saving writes the note through; an empty note clears it. */
  protected saveNote(note: string): void {
    const editing = this.noteEditing();
    this.noteEditing.set(undefined);
    if (editing !== undefined) {
      this.noteEdited.emit({ id: editing.pin.id, note: note.trim() });
    }
  }

  /** ⌫ on a band: unpin the range. */
  protected unpinPin(pin: EditorPin): void {
    if (this.noteEditing()?.pin.id === pin.id) {
      this.noteEditing.set(undefined);
    }
    this.unpinned.emit({ id: pin.id });
  }

  // --- the document ----------------------------------------------------------

  /**
   * Report the selection a pin could be made from, so the file's header can offer it.
   * A drag on the line numbers is a pin in progress, not a selection to offer, and a
   * diff offers nothing: its gesture is a click on a change block.
   */
  private reportSelection(view: EditorView): void {
    if (this.mode() !== 'file') {
      return;
    }
    const range = view.state.selection.main;
    const request = range.empty ? null : pinFromText(view.state.doc, range.from, range.to);
    const key = request === null ? null : JSON.stringify(request);
    if (key === this.reportedSelection) {
      return;
    }
    this.reportedSelection = key;
    this.selectionChanged.emit(request);
  }

  /**
   * Collapse the selection, called by the feature once the pin it asked for exists:
   * the tint is the record of those lines now, and a drag left painted over them
   * only looks like an unfinished edit.
   */
  clearSelection(): void {
    const view = this.mainView;
    if (view === undefined || view.state.selection.main.empty) {
      return;
    }
    view.dispatch({ selection: EditorSelection.cursor(view.state.selection.main.to) });
  }

  /** The whole-line range under a gutter pointer position. */
  private lineRangeAt(view: EditorView, clientY: number): { from: number; to: number } | null {
    // `documentTop` is the first line's top (the content's padding excluded), which
    // is the origin `lineBlockAtHeight` measures from.
    const block = view.lineBlockAtHeight(clientY - view.documentTop);
    const line = view.state.doc.lineAt(block.from);
    const to = line.to === line.from ? Math.min(line.to + 1, view.state.doc.length) : line.to;
    return to > line.from ? { from: line.from, to } : null;
  }

  /**
   * Dragging the line numbers pins whole lines: the range forms live as a
   * selection, and release hands it to the feature. Selecting text, by contrast,
   * offers the header's pin button — selecting is also how a reader copies.
   *
   * A diff has no line numbers of its own (it shows the two files' instead), so the
   * gesture does not exist there: its rows are pinned by clicking a change block.
   */
  private startGutterDrag(event: MouseEvent, view: EditorView): boolean {
    const target = event.target as HTMLElement | null;
    if (target === null || target.closest('.cm-lineNumbers') === null) {
      return false;
    }
    const first = this.lineRangeAt(view, event.clientY);
    if (first === null) {
      return false;
    }
    event.preventDefault();
    let from = first.from;
    let to = first.to;
    const apply = (clientY: number) => {
      const next = this.lineRangeAt(view, clientY);
      if (next === null) {
        return;
      }
      from = Math.min(first.from, next.from);
      to = Math.max(first.to, next.to);
      view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: false });
    };
    apply(event.clientY);
    const move = (pointer: PointerEvent) => apply(pointer.clientY);
    const up = (pointer: PointerEvent) => {
      document.removeEventListener('pointermove', move);
      apply(pointer.clientY);
      const request = pinFromText(view.state.doc, from, to, { lineOnly: true });
      if (request !== null) {
        // Applied: the highlight is the answer, not a pair left over the lines, and
        // not a drag still painted across them.
        this.dismissed.set(true);
        this.pinRequested.emit(request);
        this.clearSelection();
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    return true;
  }

  private replaceText(text: string): void {
    const view = this.mainView;
    if (this.mode() !== 'file' || view === undefined || view.state.doc.toString() === text) {
      return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }

  /**
   * Install the grammar for a path, once. A later path wins the race: a slow
   * chunk for the file the reader already left must not land in this one.
   */
  private async applyLanguage(path: string): Promise<void> {
    if (this.loadedPath === path) {
      return;
    }
    this.loadedPath = path;
    this.grammar = null;
    const language = await loadLanguage(path);
    if (this.loadedPath !== path) {
      return;
    }
    this.grammar = language;
    this.applyGrammar();
  }

  /**
   * Put the loaded grammar into every live view. A mode switch builds new views, so
   * the grammar has to be handed over again rather than only when the path changes.
   */
  private applyGrammar(): void {
    for (const surface of this.surfaces()) {
      surface.view.dispatch({ effects: this.language.reconfigure(this.grammar ?? []) });
    }
  }

  /**
   * Reveal a line: the new file's where the surface shows it, the old file's when
   * only that side has it (a deletion), and the plain line number for a file.
   */
  private reveal(line: number): void {
    for (const surface of this.surfaces()) {
      const target =
        surface.document === undefined ? line : revealDocLine(surface.document, line);
      if (target !== undefined) {
        this.flash(surface.view, target);
        return;
      }
    }
    if (this.mainView !== undefined) {
      this.flash(this.mainView, line);
    }
  }

  private flash(view: EditorView, line: number): void {
    revealLine(view, line);
    if (this.flashTimer !== undefined) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      this.mainView?.dispatch({ effects: clearFlash.of(null) });
      this.leftView?.dispatch({ effects: clearFlash.of(null) });
    }, FLASH_MS);
  }
}
