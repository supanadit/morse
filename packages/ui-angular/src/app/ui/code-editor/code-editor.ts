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
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions } from './editor-setup';
import { loadLanguage } from './languages';
import type { EditorPin } from './pins';
import type { PinRequest } from './pin-selection';
import { clearFlash, flashExtension, revealLine } from './scroll';

/** How long a jumped-to line stays lit. */
const FLASH_MS = 900;

@Component({
  selector: 'morse-code-editor',
  templateUrl: './code-editor.html',
  styleUrl: './code-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // CodeMirror builds its own DOM, so emulated encapsulation would never reach
  // it; the stylesheet scopes every selector to the host element instead, and
  // `conventions.spec.ts` holds that line.
  encapsulation: ViewEncapsulation.None,
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
  private readonly language = new Compartment();
  private readonly ready = signal(false);
  private view: EditorView | undefined;
  private loadedPath: string | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

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
    inject(DestroyRef).onDestroy(() => {
      if (this.flashTimer !== undefined) {
        clearTimeout(this.flashTimer);
      }
      this.view?.destroy();
    });
  }

  private mount(): void {
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.text(),
        extensions: [editorExtensions(), flashExtension, this.language.of([])],
      }),
    });
    this.ready.set(true);
    void this.applyLanguage(this.path());
    const line = this.line();
    if (line !== undefined) {
      this.reveal(line);
    }
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
