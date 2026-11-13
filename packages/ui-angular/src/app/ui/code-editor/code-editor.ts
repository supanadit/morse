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
} from '@angular/core';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { foldedRanges } from '@codemirror/language';
import { editorExtensions } from './editor-setup';
import { loadLanguage } from './languages';
import type { EditorPin } from './pins';
import { pillAnchoredAt, pinFromOffsets, pinRangeLabel, type PinRequest } from './pin-selection';
import { railSlots } from './rail';
import { clearFlash, flashExtension, revealLine } from './scroll';
import { Markdown } from '../markdown/markdown';

/** How long a jumped-to line stays lit. */
const FLASH_MS = 900;
/** The pill's assumed box, used to keep it inside the viewport. */
const PILL_SIZE = { width: 132, height: 26 } as const;
/** Every card is the same height (the note clamps), so placement needs no measuring. */
const CARD_HEIGHT = 76;

/** The floating "pin this selection" affordance. */
interface Pill {
  readonly left: number;
  readonly top: number;
  readonly label: string;
  readonly from: number;
  readonly to: number;
}

/** One card in the rail, already placed. */
interface RailCard {
  readonly pin: EditorPin;
  readonly label: string;
  readonly top: number;
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
  imports: [Markdown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // CodeMirror builds its own DOM, so emulated encapsulation would never reach
  // it; the stylesheet scopes every selector to the host element instead, and
  // `conventions.spec.ts` holds that line.
  encapsulation: ViewEncapsulation.None,
  host: { '(keydown)': 'onEditorKeydown($event)' },
})
export class CodeEditor {
  /** The file's text, as the tab store read it. */
  readonly text = input.required<string>();
  /** The file's path: the grammar's key, and the accessible name. */
  readonly path = input.required<string>();
  /** A 1-based line to reveal and flash (search hits, git jumps, a chip click). */
  readonly line = input<number | undefined>(undefined);
  /** This file's ranges; the rail draws a tint and a card for each. */
  readonly pins = input<readonly EditorPin[]>([]);

  readonly pinRequested = output<PinRequest>();
  readonly noteEdited = output<{ id: string; note: string }>();
  readonly unpinned = output<{ id: string }>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');
  private readonly language = new Compartment();
  private readonly ready = signal(false);
  /** The selection pill, when a confirmation-worthy selection exists. */
  protected readonly pill = signal<Pill | undefined>(undefined);
  /** The rail's cards, placed in document coordinates. */
  protected readonly cards = signal<readonly RailCard[]>([]);
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
              this.refreshCards(update.view);
            }
          }),
          EditorView.domEventHandlers({
            mousedown: (event, view) => this.startGutterDrag(event, view),
          }),
        ],
      }),
    });
    this.view?.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.ready.set(true);
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
    this.refreshCards(view);
  }

  /**
   * Place each card beside its line, in document coordinates: the rail track is
   * translated by the scroll offset, so cards move with the text and are placed
   * once per measure rather than once per scroll pixel.
   */
  private refreshCards(view: EditorView): void {
    const doc = view.state.doc;
    const folded = foldedRanges(view.state);
    const pinned = this.pins();
    const anchors = pinned.map((pin) => {
      const number = Math.min(Math.max(1, pin.startLine), doc.lines);
      const line = doc.line(number);
      let hidden = false;
      folded.between(line.from, line.from, () => {
        hidden = true;
        return false;
      });
      return hidden ? null : view.lineBlockAt(line.from).top;
    });
    const slots = railSlots(anchors, pinned.map(() => CARD_HEIGHT));
    const cards: RailCard[] = [];
    pinned.forEach((pin, index) => {
      const slot = slots[index];
      if (slot !== null && slot !== undefined) {
        cards.push({ pin, label: pinRangeLabel(pin), top: slot.top });
      }
    });
    this.cards.set(cards);
    this.syncTrack();
  }

  /** Keep the rail's cards beside their lines while the editor scrolls. */
  private syncTrack(): void {
    const track = this.track()?.nativeElement;
    const view = this.view;
    if (track === undefined || view === undefined) {
      return;
    }
    track.style.transform = `translateY(${-view.scrollDOM.scrollTop}px)`;
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
    const request = pinFromOffsets(view.state.doc.toString(), range.from, range.to);
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
    const request = pinFromOffsets(view.state.doc.toString(), pill.from, pill.to);
    if (request !== null) {
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
    const box = view.scrollDOM.getBoundingClientRect();
    const block = view.lineBlockAtHeight(clientY - box.top + view.scrollDOM.scrollTop);
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
      const request = pinFromOffsets(view.state.doc.toString(), from, to, { lineOnly: true });
      if (request !== null) {
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
