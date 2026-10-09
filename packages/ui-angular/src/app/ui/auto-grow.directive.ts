import {
  AfterViewInit,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
} from '@angular/core';

/**
 * Grow a `<textarea>` to fit what is in it, up to a cap. The prompt-template
 * form needs it: an argument may be a pasted stack trace or a paragraph, and a
 * fixed two-row box hides all but the first line of it.
 *
 *   <textarea rows="1" [morseAutoGrow]="200"></textarea>
 *
 * Height is reset to `auto` before reading `scrollHeight`, or the box could
 * only ever grow — `scrollHeight` never reports less than the current height.
 * The cap is in pixels; past it the textarea scrolls instead of pushing the
 * dialog's buttons off-screen.
 *
 * The directive listens for `input` itself rather than relying on the bound
 * `(input)` handler, so a paste that does not trip Angular's binding still
 * resizes. jsdom reports `scrollHeight` as 0, so a measurement of nothing is
 * ignored and the stylesheet's `rows` stands.
 */
@Directive({ selector: 'textarea[morseAutoGrow]' })
export class AutoGrowDirective implements AfterViewInit {
  /** Tallest the box may get, in pixels. */
  readonly morseAutoGrow = input<number>(200);

  private readonly host = inject<ElementRef<HTMLTextAreaElement>>(ElementRef);
  private readonly onInput = (): void => this.resize();

  constructor() {
    inject(DestroyRef).onDestroy(() =>
      this.host.nativeElement.removeEventListener('input', this.onInput),
    );
  }

  ngAfterViewInit(): void {
    this.host.nativeElement.addEventListener('input', this.onInput);
    this.resize();
  }

  private resize(): void {
    const area = this.host.nativeElement;
    area.style.height = 'auto';
    const measured = area.scrollHeight;
    if (measured <= 0) {
      area.style.height = '';
      return;
    }
    const cap = this.morseAutoGrow();
    area.style.height = `${Math.min(measured, cap)}px`;
    area.style.overflowY = measured > cap ? 'auto' : 'hidden';
  }
}
