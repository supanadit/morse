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

/**
 * Paints markdown formatting behind the textarea it wraps. The textarea stays
 * the only input surface and the only source of truth: the painted layer shows
 * exactly the characters in the buffer, decorated, so what is typed is what is
 * sent and persisted — the mirror can only restyle it (spec:
 * `ui/markdown-composer`).
 *
 * Geometry rule: the mirror is line-for-line with the textarea, so it changes
 * color and background but never the text or its metrics — both layers read one
 * set of custom properties (`--mdp-*`), and every decoration is a span over
 * verbatim characters (`decorateMarkdown` in `@morse/ui-runtime`), so the
 * mirror's `textContent` is always the textarea's value, character for
 * character.
 *
 * The decoration set: fenced code blocks as tinted, syntax-colored panels (the
 * same `highlight.js` the transcript uses), and inline code, emphasis, links,
 * headings and list markers in distinct colors. Incomplete constructs decorate
 * to the end of the draft, so formatting grows as it is typed. During IME
 * composition the textarea shows its own text instead: the buffer has not
 * caught up with the composition yet, and painting over it would double it.
 */
@Component({
  selector: 'morse-markdown-paint',
  templateUrl: './markdown-paint.html',
  styleUrl: './markdown-paint.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.composing]': 'composing()' },
})
export class MarkdownPaint implements AfterContentInit {
  /** The buffer to mirror; a change schedules a paint. */
  readonly value = input.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  /** While true, the textarea is mid-composition and paints its own text. */
  protected readonly composing = signal(false);
  protected readonly html = signal('');
  private area: HTMLTextAreaElement | undefined;
  private frame: number | undefined;

  constructor() {
    // Painting is scheduled, never synchronous: the input path must never wait
    // on it, and a burst of typing coalesces into one scan per frame.
    effect(() => {
      this.value();
      this.schedule();
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.frame !== undefined) {
        cancelFrame(this.frame);
      }
      this.area?.removeEventListener('scroll', this.syncScroll);
      this.area?.removeEventListener('compositionstart', this.onCompositionStart);
      this.area?.removeEventListener('compositionend', this.onCompositionEnd);
    });
  }

  /** Binds to the projected textarea: scroll sync and IME composition. */
  ngAfterContentInit(): void {
    const area = this.host.nativeElement.querySelector('textarea');
    if (!area) {
      return;
    }
    this.area = area;
    area.addEventListener('scroll', this.syncScroll, { passive: true });
    area.addEventListener('compositionstart', this.onCompositionStart);
    area.addEventListener('compositionend', this.onCompositionEnd);
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
      this.html.set(decoratedMarkdownHtml(value));
      this.syncScroll();
    });
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
