import {
  AfterContentInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { decoratedMarkdownHtml } from '@morse/ui-runtime';
import { PositionMap, type ViewRect } from './position-map';

export interface SelectionBand {
  left: number;
  top: number;
  width: number;
  height: number;
}

@Component({
  selector: 'morse-markdown-view',
  templateUrl: './markdown-view.html',
  styleUrl: './markdown-view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.composing]': 'composing()', '[class.view-mode]': 'viewMode()' },
})
export class MarkdownView implements AfterContentInit {
  /** The buffer to mirror/view; a change schedules a paint. */
  readonly value = input.required<string>();
  /** Feature flag: viewMode enables block panels & custom caret; default false. */
  readonly viewMode = input<boolean>(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  /** While true, the textarea is mid-composition and paints its own text. */
  protected readonly composing = signal(false);
  protected readonly html = signal('');
  protected readonly caretVisible = signal(false);
  protected readonly caretRect = signal<ViewRect>({ left: 6, top: 4, right: 6, bottom: 24, width: 2, height: 20 });
  protected readonly selectionBands = signal<SelectionBand[]>([]);

  private area: HTMLTextAreaElement | undefined;
  private frame: number | undefined;
  private positionMap: PositionMap | undefined;

  constructor() {
    // Painting is scheduled, never synchronous: the input path must never wait
    // on it, and a burst of typing coalesces into one scan per frame.
    effect(() => {
      this.value();
      this.viewMode();
      this.schedule();
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.frame !== undefined) {
        cancelFrame(this.frame);
      }
      this.cleanupEvents();
    });
  }

  /** Binds to the projected textarea: scroll sync, selection tracking, and IME composition. */
  ngAfterContentInit(): void {
    const area = this.host.nativeElement.querySelector('textarea');
    if (!area) {
      return;
    }
    this.area = area;
    area.addEventListener('scroll', this.syncScroll, { passive: true });
    area.addEventListener('compositionstart', this.onCompositionStart);
    area.addEventListener('compositionend', this.onCompositionEnd);
    area.addEventListener('focus', this.onFocus);
    area.addEventListener('blur', this.onBlur);
    area.addEventListener('select', this.onSelectionChange);
    area.addEventListener('keyup', this.onSelectionChange);
    area.addEventListener('mouseup', this.onSelectionChange);
    area.addEventListener('click', this.onSelectionChange);

    // Also listen to document selectionchange if focused
    document.addEventListener('selectionchange', this.onDocSelectionChange);
  }

  private cleanupEvents(): void {
    if (this.area) {
      this.area.removeEventListener('scroll', this.syncScroll);
      this.area.removeEventListener('compositionstart', this.onCompositionStart);
      this.area.removeEventListener('compositionend', this.onCompositionEnd);
      this.area.removeEventListener('focus', this.onFocus);
      this.area.removeEventListener('blur', this.onBlur);
      this.area.removeEventListener('select', this.onSelectionChange);
      this.area.removeEventListener('keyup', this.onSelectionChange);
      this.area.removeEventListener('mouseup', this.onSelectionChange);
      this.area.removeEventListener('click', this.onSelectionChange);
    }
    document.removeEventListener('selectionchange', this.onDocSelectionChange);
  }

  private schedule(): void {
    if (this.frame !== undefined) {
      return;
    }
    this.frame = nextFrame(() => {
      this.frame = undefined;
      if (this.composing()) {
        return;
      }
      const value = this.value();
      this.rebuildPositionMap(value);
      const isVm = this.viewMode();
      const sel: [number, number] | undefined =
        this.area && this.area.selectionStart !== null && this.area.selectionEnd !== null
          ? [this.area.selectionStart, this.area.selectionEnd]
          : undefined;
      this.html.set(decoratedMarkdownHtml(value, { viewMode: isVm, selection: sel }) + '<br>');
      this.syncScroll();
      if (isVm) {
        this.updateSelectionAndCaret();
      }
    });
  }

  private rebuildPositionMap(value: string): void {
    const box = this.box()?.nativeElement;
    const computed = box ? getComputedStyle(box) : undefined;
    const lineHeight = computed ? parseFloat(computed.lineHeight) || 20 : 20;
    const paddingLeft = computed ? parseFloat(computed.paddingLeft) || 6 : 6;
    const paddingTop = computed ? parseFloat(computed.paddingTop) || 4 : 4;
    const paddingRight = computed ? parseFloat(computed.paddingRight) || 6 : 6;
    const containerWidth = box?.clientWidth || 600;

    this.positionMap = new PositionMap({
      text: value,
      metrics: {
        lineHeight,
        charWidth: 8,
        paddingLeft,
        paddingTop,
        paddingRight,
        containerWidth,
      },
    });
  }

  private readonly onFocus = (): void => {
    if (this.viewMode()) {
      this.caretVisible.set(true);
      this.updateSelectionAndCaret();
    }
  };

  private readonly onBlur = (): void => {
    this.caretVisible.set(false);
    this.selectionBands.set([]);
  };

  private readonly onSelectionChange = (): void => {
    if (this.viewMode()) {
      this.updateSelectionAndCaret();
      this.schedule();
    }
  };

  private readonly onDocSelectionChange = (): void => {
    if (this.viewMode() && document.activeElement === this.area) {
      this.updateSelectionAndCaret();
      this.schedule();
    }
  };

  private updateSelectionAndCaret(): void {
    if (!this.area || !this.positionMap) {
      return;
    }
    const start = this.area.selectionStart ?? 0;
    const end = this.area.selectionEnd ?? 0;
    const isFocused = document.activeElement === this.area;
    this.caretVisible.set(isFocused);

    if (start === end) {
      this.selectionBands.set([]);
      const rect = this.positionMap.bufferToRect(start);
      this.caretRect.set(rect);
    } else {
      // Calculate selection band(s)
      const rectStart = this.positionMap.bufferToRect(start);
      const rectEnd = this.positionMap.bufferToRect(end);

      const bands: SelectionBand[] = [];
      if (rectStart.top === rectEnd.top) {
        bands.push({
          left: rectStart.left,
          top: rectStart.top,
          width: Math.max(2, rectEnd.left - rectStart.left),
          height: rectStart.height,
        });
      } else {
        // Multi-line selection
        bands.push({
          left: rectStart.left,
          top: rectStart.top,
          width: Math.max(10, 400),
          height: rectStart.height,
        });
        bands.push({
          left: 6,
          top: rectEnd.top,
          width: Math.max(10, rectEnd.left - 6),
          height: rectEnd.height,
        });
      }
      this.selectionBands.set(bands);
      const activeRect = this.area.selectionDirection === 'backward' ? rectStart : rectEnd;
      this.caretRect.set(activeRect);
    }
  }

  /** The mirror scrolls where the textarea scrolls; the layers are one view. */
  private readonly syncScroll = (): void => {
    const box = this.box()?.nativeElement;
    if (box && this.area) {
      box.scrollTop = this.area.scrollTop;
    }
  };

  private readonly onCompositionStart = (): void => {
    this.composing.set(true);
  };

  private readonly onCompositionEnd = (): void => {
    this.composing.set(false);
    this.schedule();
  };
}

function nextFrame(callback: FrameRequestCallback): number {
  const request = globalThis.requestAnimationFrame;
  return request ? request(callback) : (setTimeout(callback, 0) as unknown as number);
}

function cancelFrame(frame: number): void {
  const cancel = globalThis.cancelAnimationFrame;
  if (cancel) {
    cancel(frame);
  } else {
    clearTimeout(frame as unknown as ReturnType<typeof setTimeout>);
  }
}

export const MarkdownPaint = MarkdownView;
export type MarkdownPaint = MarkdownView;
