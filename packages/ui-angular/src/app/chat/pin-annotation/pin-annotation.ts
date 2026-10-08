/**
 * The annotation editor: the markdown popover a pinned range's ✎ opens.
 *
 * It is anchored to whatever opened it (a composer chip, a band's corner, a diff
 * row) — hence `placePopover` — and it is where an annotation is actually
 * written: a formatting toolbar, the usual markdown shortcuts, and the source
 * rendered *in place* while typing (see `mirror.ts`), so `**bold**` reads as
 * bold the moment the closing stars are typed. The value stays markdown from end
 * to end: the editor never converts the draft, it only paints it.
 *
 * `save` hands the markdown up as-is — clearing is saving nothing — and the
 * caller routes it to the pin it belongs to.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { renderAnnotationMirror } from './mirror';
import { placePopover, type PopoverAnchor, type PopoverSize } from './placement';

/** What the editor says it is annotating: the file, and its range if it has one. */
export interface AnnotationTarget {
  path: string;
  /** `L30-31`-style label; absent for a whole-file pin. */
  range?: string;
}

/** The card's wish before it has been measured; also placement's first guess. */
const PREFERRED_SIZE: PopoverSize = { width: 560, height: 360 };
const VIEWPORT_FALLBACK: PopoverSize = { width: 1_024, height: 768 };

/** The line the footer documents, so the shortcuts are discoverable. */
const SHORTCUT_HINT = 'Markdown · ⌘/Ctrl+B bold · I italic · E code · K link · ⏎ saves';

@Component({
  selector: 'morse-pin-annotation',
  templateUrl: './pin-annotation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      /*
       * Fixed, not absolute: the anchor can be anywhere — a chip, a band corner
       * in the preview pane, a diff row — so the card is placed from the anchor's
       * viewport rect by placePopover() and lives above every pane.
       */
      .pin-annotation {
        position: fixed;
        z-index: 80;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(560px, calc(100vw - 16px));
        padding: 12px 14px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        animation: annotation-in 120ms ease-out;
      }
      @keyframes annotation-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 7px;
        min-width: 0;
      }
      .head .glyph {
        color: var(--morse-accent);
        font-size: 12px;
        line-height: 1;
      }
      .head .title {
        font-size: 12px;
        font-weight: 600;
      }
      .head .target {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 11px;
      }
      .head .range {
        flex: none;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--morse-active);
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 10.5px;
      }
      .head .grow,
      footer .grow {
        flex: 1;
      }
      /* A toolbar button is a control, not prose: reset hard at every state. */
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
      }
      .toolbar button {
        min-width: 26px;
        padding: 2px 6px;
        border: 1px solid transparent;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        cursor: pointer;
      }
      .toolbar button:hover:not(:disabled),
      .toolbar button:focus-visible {
        border-color: var(--morse-border);
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      /*
       * The write surface: a textarea whose text is transparent over the mirror of
       * the same text. Both layers are monospace at the same size and line-height,
       * and the mirror's syntax marks keep their width (visibility: hidden), so the
       * caret stays on the character it is editing. The mirror's own markup is
       * styled in styles.css, because injected HTML cannot see component styles.
       */
      .editor {
        position: relative;
        height: min(38vh, 280px);
        overflow: hidden;
        border: 1px solid var(--morse-input-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-input-bg);
        font-family: var(--morse-font-mono);
        font-size: 12px;
        line-height: 1.65;
      }
      .editor:focus-within {
        border-color: var(--morse-focus);
      }
      .mirror,
      .input {
        position: absolute;
        inset: 0;
        margin: 0;
        padding: 8px 10px;
        border: 0;
        font: inherit;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        tab-size: 2;
      }
      .mirror {
        overflow: hidden;
        pointer-events: none;
        color: var(--morse-fg);
      }
      .mirror code {
        font: inherit;
      }
      .input {
        width: 100%;
        height: 100%;
        background: transparent;
        color: transparent;
        caret-color: var(--morse-fg);
        resize: none;
        overflow: auto;
        outline: none;
      }
      .input::selection {
        color: transparent;
        background: color-mix(in srgb, var(--morse-accent) 35%, transparent);
      }
      footer {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      footer .hint {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 10.5px;
      }
      footer button {
        flex: none;
      }
      .secondary {
        border: 1px solid var(--morse-border);
        background: transparent;
        color: var(--morse-fg-muted);
      }
      .secondary:hover:not(:disabled),
      .secondary:focus-visible {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
    `,
  ],
})
export class PinAnnotation {
  /** Where the ✎ that opened this card is, in viewport coordinates. */
  readonly anchor = input.required<PopoverAnchor>();
  /** What is being annotated, for the header. */
  readonly target = input.required<AnnotationTarget>();
  /** The markdown the pin already carries, if any. */
  readonly note = input('');

  readonly save = output<string>();
  readonly cancel = output<void>();

  protected readonly shortcutHint = SHORTCUT_HINT;
  protected readonly spot = computed(() =>
    placePopover(this.anchor(), this.measured(), {
      width: typeof window === 'undefined' ? VIEWPORT_FALLBACK.width : window.innerWidth,
      height: typeof window === 'undefined' ? VIEWPORT_FALLBACK.height : window.innerHeight,
    }),
  );
  /** The draft once the user has touched it; `null` means "still the pin's note". */
  protected readonly mirrorHtml = computed(() => renderAnnotationMirror(this.draft()));

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');
  private readonly mirror = viewChild<ElementRef<HTMLElement>>('mirror');
  private readonly measured = signal<PopoverSize>(PREFERRED_SIZE);
  private readonly typed = signal<string | null>(null);
  protected readonly draft = computed(() => this.typed() ?? this.note());
  private observer: ResizeObserver | undefined;

  constructor() {
    // The card's real height decides whether it fits below its anchor, so the
    // first paint measures it — and a later resize (a wrapped line) re-measures.
    afterNextRender(() => {
      this.measure();
      const element = this.card()?.nativeElement;
      if (element !== undefined && typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.measure());
        this.observer.observe(element);
      }
    });
    inject(DestroyRef).onDestroy(() => this.observer?.disconnect());
  }

  /** A press anywhere outside the card is a cancel, like every other popover. */
  @HostListener('document:pointerdown', ['$event'])
  protected onOutsidePointer(event: PointerEvent): void {
    const element = this.card()?.nativeElement;
    const target = event.target;
    if (element === undefined || !(target instanceof Node) || element.contains(target)) {
      return;
    }
    this.close();
  }

  protected onInput(event: Event): void {
    this.typed.set((event.target as HTMLTextAreaElement).value);
  }

  /** The mirror follows the textarea's scroll: they are the same text, layered. */
  protected onScroll(): void {
    const area = this.input()?.nativeElement;
    const mirror = this.mirror()?.nativeElement;
    if (area === undefined || mirror === undefined) {
      return;
    }
    mirror.style.transform = `translateY(${-area.scrollTop}px)`;
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit();
      return;
    }
    switch (event.key.toLowerCase()) {
      case 'b':
        event.preventDefault();
        this.bold();
        return;
      case 'i':
        event.preventDefault();
        this.italic();
        return;
      case 'e':
        event.preventDefault();
        this.inlineCode();
        return;
      case 'k':
        event.preventDefault();
        this.link();
        return;
      default:
        return;
    }
  }

  // --- the toolbar -----------------------------------------------------------

  protected bold(): void {
    this.wrap('**', '**', 'bold text');
  }

  protected italic(): void {
    this.wrap('*', '*', 'italic text');
  }

  protected inlineCode(): void {
    this.wrap('`', '`', 'code');
  }

  /** A fenced block around the selection — or an empty one to type into. */
  protected codeBlock(): void {
    const area = this.input()?.nativeElement;
    if (area === undefined) {
      return;
    }
    const { value, selectionStart, selectionEnd } = area;
    const selected = value.slice(selectionStart, selectionEnd);
    const lead = selectionStart === 0 || value.charAt(selectionStart - 1) === '\n' ? '' : '\n';
    const insert = `${lead}\`\`\`\n${selected}\n\`\`\`\n`;
    this.replace(area, value.slice(0, selectionStart) + insert + value.slice(selectionEnd), {
      start: selectionStart + lead.length + 4,
      end: selectionStart + lead.length + 4 + selected.length,
    });
  }

  /** `[text](url)`, with the `url` selected so the next keystroke replaces it. */
  protected link(): void {
    const area = this.input()?.nativeElement;
    if (area === undefined) {
      return;
    }
    const { value, selectionStart, selectionEnd } = area;
    const text = value.slice(selectionStart, selectionEnd) || 'link text';
    const urlStart = selectionStart + 1 + text.length + 2;
    this.replace(
      area,
      value.slice(0, selectionStart) + `[${text}](url)` + value.slice(selectionEnd),
      { start: urlStart, end: urlStart + 3 },
    );
  }

  protected bullet(): void {
    this.prefix('- ');
  }

  protected ordered(): void {
    this.prefix('', true);
  }

  protected heading(): void {
    this.prefix('## ');
  }

  protected quote(): void {
    this.prefix('> ');
  }

  // --- saving ----------------------------------------------------------------

  protected commit(): void {
    this.save.emit(this.draft());
  }

  protected close(): void {
    this.cancel.emit();
  }

  // --- the mechanics ---------------------------------------------------------

  /** Wraps the selection (or a placeholder) in a markdown pair. */
  private wrap(open: string, close: string, placeholder: string): void {
    const area = this.input()?.nativeElement;
    if (area === undefined) {
      return;
    }
    const { value, selectionStart, selectionEnd } = area;
    const selected = value.slice(selectionStart, selectionEnd) || placeholder;
    const inner = selectionStart + open.length;
    this.replace(area, value.slice(0, selectionStart) + `${open}${selected}${close}` + value.slice(selectionEnd), {
      start: inner,
      end: inner + selected.length,
    });
  }

  /** Puts a marker in front of every line in the selection. */
  private prefix(marker: string, numbered = false): void {
    const area = this.input()?.nativeElement;
    if (area === undefined) {
      return;
    }
    const { value, selectionStart, selectionEnd } = area;
    const start = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    const lineEnd = value.indexOf('\n', selectionEnd);
    const stop = lineEnd === -1 ? value.length : lineEnd;
    const prefixed = value
      .slice(start, stop)
      .split('\n')
      .map((line, index) => `${numbered ? `${index + 1}. ` : marker}${line}`)
      .join('\n');
    this.replace(area, value.slice(0, start) + prefixed + value.slice(stop), {
      start,
      end: start + prefixed.length,
    });
  }

  /**
   * Writes a new draft straight into the textarea and puts the selection where
   * the edit left it. Imperative on purpose: the mirror only needs the signal,
   * and restoring a selection has to happen before Angular repaints, or the caret
   * jumps to the end of the text.
   */
  private replace(
    area: HTMLTextAreaElement,
    next: string,
    selection: { start: number; end: number },
  ): void {
    area.value = next;
    this.typed.set(next);
    area.focus();
    area.selectionStart = selection.start;
    area.selectionEnd = selection.end;
    this.onScroll();
  }

  /** Reads the card's real size so placement can decide above or below. */
  private measure(): void {
    const element = this.card()?.nativeElement;
    if (element === undefined) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    const current = untracked(() => this.measured());
    if (next.width !== current.width || next.height !== current.height) {
      this.measured.set(next);
    }
  }
}
