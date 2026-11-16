import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewEncapsulation,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

/** How long a control says "✓ Copied" before it offers to copy again. */
const CONFIRM_MS = 1200;

/**
 * The one copy control both transcripts use: a line's words, on the clipboard,
 * with the same glyphs and the same confirmation wherever a reader meets it.
 *
 * It knows nothing about messages — only the text to copy and the words around
 * it — because the two modes differ in what surrounds it, not in the gesture:
 * code mode puts it on a byline with the model's name, bot mode beside an
 * avatar, a handle and a timestamp. Sharing the control is what keeps those two
 * from drifting into two slightly different buttons.
 *
 * Its styles are deliberately unscoped. The control fades in with the row that
 * hosts it, and that row belongs to another component's template: scoped styles
 * cannot reach across that boundary, so the reveal rules below name the rows
 * they serve (`.user`, `.assistant`, `.entry`) instead.
 */
@Component({
  selector: 'morse-copy-button',
  templateUrl: './copy-button.html',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './copy-button.css',
})
export class CopyButton {
  /** What lands on the clipboard: the message's markdown source, verbatim. */
  readonly text = input.required<string>();
  /**
   * The words after the glyph, for a control with room to say what it does
   * (`Copy`, `Copy response`). Absent leaves the glyph alone, which is what a
   * narrow row — the reader's own bubble — has space for.
   */
  readonly label = input<string>();
  /** The label once copied; defaults to `Copied`, the word both modes use. */
  readonly copiedLabel = input('Copied');
  readonly title = input('Copy message');
  readonly copiedTitle = input('Copied');

  private readonly copied = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // The timer is the component's, so it must not outlive it: a closed session
    // or a closed conversation would otherwise keep a callback alive that only
    // ever clears a signal nobody reads.
    this.destroyRef.onDestroy(() => {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
      }
    });
  }

  /**
   * The glyph, and the label when there is one. Two states only — offered, and
   * just copied — because a third would need a reader to learn it.
   */
  protected readonly mark = computed(() => {
    if (this.copied()) {
      const copiedLabel = this.copiedLabel();
      return this.label() === undefined ? `✓` : `✓ ${copiedLabel}`;
    }
    const label = this.label();
    return label === undefined ? `⧉` : `⧉ ${label}`;
  });

  protected copy(): void {
    void navigator.clipboard?.writeText(this.text());
    this.copied.set(true);
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.copied.set(false);
      this.timer = undefined;
    }, CONFIRM_MS);
  }
}
