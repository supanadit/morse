/**
 * The annotation editor: the markdown popover a pinned range's ✎ opens.
 *
 * It is anchored to whatever opened it (a composer chip, a band's corner, a diff
 * row) — hence `placePopover` — and it is where an annotation is actually
 * written: a formatting toolbar, the usual markdown shortcuts, and two tabs —
 * **Write** for the source, **Preview** for the rendered result. The draft stays
 * markdown from end to end; the editor never converts it, Preview only paints it
 * through the same renderer the transcript uses.
 *
 * Write and Preview are separate surfaces on purpose. An earlier version overlaid
 * a transparent textarea on a live mirror of its own markup so `**bold**` read as
 * bold while typing; keeping two layers on one grid proved impossible to hold (a
 * stray background, a wrapping difference, a synthetic face and the prose slid
 * out from under the caret). Two tabs give each layer the whole box and nothing
 * to disagree about.
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
import { placePopover, type PopoverAnchor, type PopoverSize } from '@morse/ui-runtime';
import { Markdown } from '../markdown/markdown';

/** What the editor says it is annotating: the file, and its range if it has one. */
export interface AnnotationTarget {
  path: string;
  /** `L30-31`-style label; absent for a whole-file pin. */
  range?: string;
}

/** Which of the two surfaces is showing: the source, or its rendering. */
type EditorTab = 'write' | 'preview';

/** The card's wish before it has been measured; also placement's first guess. */
const PREFERRED_SIZE: PopoverSize = { width: 560, height: 360 };
const VIEWPORT_FALLBACK: PopoverSize = { width: 1_024, height: 768 };

/** The line the footer documents, so the shortcuts are discoverable. */
const SHORTCUT_HINT = 'Markdown · ⌘/Ctrl+B bold · I italic · E code · K link · ⏎ saves';

/** The empty field's prompt, the way a review comment invites one. */
const PLACEHOLDER = 'Leave a comment';

@Component({
  selector: 'morse-pin-annotation',
  templateUrl: './pin-annotation.html',
  imports: [Markdown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './pin-annotation.css',
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
  protected readonly placeholder = PLACEHOLDER;
  protected readonly spot = computed(() =>
    placePopover(this.anchor(), this.measured(), {
      width: typeof window === 'undefined' ? VIEWPORT_FALLBACK.width : window.innerWidth,
      height: typeof window === 'undefined' ? VIEWPORT_FALLBACK.height : window.innerHeight,
    }),
  );
  /** Which surface is showing. Preview never accepts input, so no caret to keep. */
  protected readonly tab = signal<EditorTab>('write');

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');
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

  /**
   * Switches surfaces. Back on Write, focus goes straight to the textarea — the
   * field never left the DOM, so no after-render hop is needed and the caret can
   * be restored synchronously.
   */
  protected setTab(tab: EditorTab): void {
    if (this.tab() === tab) {
      return;
    }
    this.tab.set(tab);
    if (tab === 'write') {
      const area = this.input()?.nativeElement;
      area?.focus();
      const end = area?.value.length ?? 0;
      area?.setSelectionRange(end, end);
    }
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
   * the edit left it. Imperative on purpose: the draft signal only needs the
   * value, and restoring a selection has to happen before Angular repaints, or
   * the caret jumps to the end of the text.
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
