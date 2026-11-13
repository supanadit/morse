/**
 * A read-only CodeMirror editor for a file tab.
 *
 * The view is created once and then follows the inputs: `text` replaces the
 * document, `path` swaps the grammar (each grammar is its own lazy chunk),
 * `line` reveals and flashes, `pins` feeds the note rail. Nothing here edits the
 * document — this is a reader, and the product has no write path.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  computed,
} from '@angular/core';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { foldedRanges } from '@codemirror/language';
import { pinAtLine } from './bands';
import { editorExtensions } from './editor-setup';
import { loadLanguage } from './languages';
import type { EditorPin } from './pins';
import { pillAnchoredAt, pinFromText, type PinRequest } from './pin-selection';
import { clearFlash, flashExtension, revealLine } from './scroll';
import { PinActions } from '../pin-annotation/pin-actions';
import { PinAnnotation, type AnnotationTarget } from '../pin-annotation/pin-annotation';
import { pinRangeLabel, type PopoverAnchor } from '@morse/ui-runtime';

/** How long a jumped-to line stays lit. */
const FLASH_MS = 900;
/** The pill's assumed box, used to keep it inside the viewport. */
const PILL_SIZE = { width: 132, height: 26 } as const;

/** The floating "pin this selection" affordance. */
interface Pill {
  readonly left: number;
  readonly top: number;
  readonly label: string;
  readonly from: number;
  readonly to: number;
}

/** A pin's note/Cancel pair, floating at the bottom edge of its band. */
interface BandAction {
  readonly pin: EditorPin;
  readonly top: number;
}

/** The card whose note is open in the annotation editor. */
interface NoteEditor {
  readonly pin: EditorPin;
  readonly anchor: PopoverAnchor;
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
  host: { '(keydown)': 'onEditorKeydown($event)', '[attr.aria-label]': "'File ' + path()" },
})
export class CodeEditor {
  /** The file's text, as the tab store read it. */
  readonly text = input.required<string>();
  /** The file's path: the grammar's key, and the accessible name. */
  readonly path = input.required<string>();
  /** A 1-based line to reveal and flash (search hits, git jumps, a chip click). */
  readonly line = input<number | undefined>(undefined);
  /** This file's ranges; the editor tints each and floats its note pair on it. */
  readonly pins = input<readonly EditorPin[]>([]);

  readonly pinRequested = output<PinRequest>();
  readonly noteEdited = output<{ id: string; note: string }>();
  readonly unpinned = output<{ id: string }>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly bandTrack = viewChild<ElementRef<HTMLElement>>('bandTrack');
  private readonly language = new Compartment();
  /** The selection pill, when a confirmation-worthy selection exists. */
  protected readonly pill = signal<Pill | undefined>(undefined);
  /**
   * Each pin's pair, at the bottom of its band in document coordinates.
   *
   * There is no card column beside the code: the note rides the band's own `Notes`
   * chip, which renders it on hover and opens the annotation editor on a click. A
   * fixed rail spent 240px of every file's reading width to repeat what the chip
   * already holds.
   */
  protected readonly bandActions = signal<readonly BandAction[]>([]);
  /** The line the pointer is on, while it is over the code. */
  private readonly pointerLine = signal<number | undefined>(undefined);
  /** A pair the reader has just used, so it steps aside instead of sitting there. */
  protected readonly dismissed = signal(false);
  /**
   * The band the pointer is over: the only one whose pair is on screen. Its id, not
   * the pin, because the store hands over fresh objects for the same ranges — a note
   * being saved must not re-arm a pair the reader already put away.
   */
  protected readonly hoveredPinId = computed(() => pinAtLine(this.pins(), this.pointerLine())?.id);
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
  private view: EditorView | undefined;
  private loadedPath: string | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** A gutter drag paints a line selection; it must not raise the pill. */
  private dragging = false;
  private readonly onScroll = () => this.syncTrack();

  constructor() {
    afterNextRender(() => this.mount());
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
      this.view?.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.view?.destroy();
    });
  }

  private mount(): void {
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.text(),
        extensions: [
          editorExtensions(),
          flashExtension,
          pinTintField,
          this.language.of([]),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged || update.geometryChanged) {
              this.updatePill(update.view);
            }
            if (update.docChanged || update.viewportChanged || update.geometryChanged) {
              this.refreshBands(update.view);
            }
          }),
          EditorView.domEventHandlers({
            mousedown: (event, view) => this.startGutterDrag(event, view),
          }),
        ],
      }),
    });
    this.view?.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    void this.applyLanguage(this.path());
    const line = this.line();
    if (line !== undefined) {
      this.reveal(line);
    }
    this.applyPins();
  }

  /** Tint every line a pin covers, and place its card. */
  private applyPins(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const doc = view.state.doc;
    const ranges: Range<Decoration>[] = [];
    for (const pin of this.pins()) {
      const first = Math.min(Math.max(1, pin.startLine), doc.lines);
      const last = Math.min(Math.max(first, pin.endLine ?? first), doc.lines);
      for (let number = first; number <= last; number += 1) {
        ranges.push(pinTint.range(doc.line(number).from));
      }
    }
    view.dispatch({ effects: setPinTints.of(Decoration.set(ranges, true)) });
    this.refreshBands(view);
  }

  /**
   * Place each pin's `Notes`/`Cancel` pair on the bottom edge of its band, in document
   * coordinates: the band track is translated by the scroll offset, so a pair moves
   * with its lines and is placed once per measure rather than once per scroll pixel.
   */
  private refreshBands(view: EditorView): void {
    const doc = view.state.doc;
    const folded = foldedRanges(view.state);
    // Each pin's pair sits on the bottom edge of its band's last line — the
    // corner the file preview's band used, now over the code itself.
    const bands: BandAction[] = [];
    for (const pin of this.pins()) {
      const number = Math.min(Math.max(1, pin.endLine ?? pin.startLine), doc.lines);
      const line = doc.line(number);
      let hidden = false;
      folded.between(line.from, line.from, () => {
        hidden = true;
        return false;
      });
      if (!hidden) {
        bands.push({ pin, top: view.lineBlockAt(line.from).bottom });
      }
    }
    this.bandActions.set(bands);
    this.syncTrack();
  }

  /** The line under the pointer, which decides whose pair is on screen. */
  protected trackPointer(event: PointerEvent): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const target = event.target;
    // The pair itself sits over a band: hovering it is not hovering the code.
    if (target instanceof Element && target.closest('morse-pin-actions') !== null) {
      return;
    }
    const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
    this.pointerLine.set(view.state.doc.lineAt(block.from).number);
  }

  /** Leaving the code — for the pair, a popover or another pane — puts the pairs away. */
  protected clearPointer(): void {
    this.pointerLine.set(undefined);
  }

  /** Keep the band pairs beside their lines while the editor scrolls. */
  private syncTrack(): void {
    const view = this.view;
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

  /** Show, move or clear the pill from the current selection. */
  private updatePill(view: EditorView): void {
    if (this.dragging) {
      return;
    }
    const range = view.state.selection.main;
    const head = range.empty ? null : view.coordsAtPos(range.head);
    if (head === null) {
      this.pill.set(undefined);
      return;
    }
    const request = pinFromText(view.state.doc, range.from, range.to);
    if (request === null) {
      this.pill.set(undefined);
      return;
    }
    const box = view.dom.getBoundingClientRect();
    const position = pillAnchoredAt(
      { left: head.left - box.left, top: head.top - box.top, bottom: head.bottom - box.top },
      { width: box.width, height: box.height },
      PILL_SIZE,
    );
    this.pill.set({
      ...position,
      label: pinRangeLabel(request),
      from: range.from,
      to: range.to,
    });
  }

  /** Enter or a click on the pill commits it; the range goes up as a request. */
  protected confirmPill(pill: Pill): void {
    const view = this.view;
    this.pill.set(undefined);
    if (view === undefined) {
      return;
    }
    const request = pinFromText(view.state.doc, pill.from, pill.to);
    if (request !== null) {
      this.dismissed.set(true);
      this.pinRequested.emit(request);
    }
  }

  /** Escape dismisses the pill; Enter confirms it. */
  protected onEditorKeydown(event: KeyboardEvent): void {
    const pill = this.pill();
    if (pill === undefined) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.pill.set(undefined);
      return;
    }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      this.confirmPill(pill);
    }
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
   * raises the pill — selecting is also how a reader copies.
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
    this.dragging = true;
    this.pill.set(undefined);
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
      this.dragging = false;
      this.pill.set(undefined);
      const request = pinFromText(view.state.doc, from, to, { lineOnly: true });
      if (request !== null) {
        // Applied: the highlight is the answer, not a pair left over the lines.
        this.dismissed.set(true);
        this.pinRequested.emit(request);
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    return true;
  }

  private replaceText(text: string): void {
    const view = this.view;
    if (view === undefined || view.state.doc.toString() === text) {
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
    const language = await loadLanguage(path);
    if (this.loadedPath !== path) {
      return;
    }
    this.view?.dispatch({ effects: this.language.reconfigure(language ?? []) });
  }

  private reveal(line: number): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    revealLine(view, line);
    if (this.flashTimer !== undefined) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      this.view?.dispatch({ effects: clearFlash.of(null) });
    }, FLASH_MS);
  }
}
