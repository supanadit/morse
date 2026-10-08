import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output } from '@angular/core';
import { OverlayStack } from '../../state/overlay-stack';

/**
 * The shell every dialog shares: the backdrop that dims the app, the card centred on
 * it, the click outside that dismisses, and the registration that makes it the
 * overlay Escape is talking about.
 *
 * Eight dialogs carried a copy of that markup and those rules, and each added its own
 * `document:keydown.escape` listener — which is why one press dismissed all the open
 * dialogs at once. Here the shell registers with `OverlayStack` while it is alive, so
 * Escape reaches the one on top and nothing else.
 *
 * What the dialog puts in the card is `ng-content`: a header, a body, a footer, or
 * none of them — the shell does not care. What the card itself measures (width,
 * height, padding, whether it scrolls) comes from the dialog's own stylesheet as
 * custom properties on `morse-dialog` (see `dialog.css`).
 *
 * The user's intent is one output: `dismiss` means "leave" — the backdrop was clicked
 * or Escape was pressed. Only the dialog knows what leaving means, and one of them
 * (the project picker) steps back through its own modes before it closes.
 */
@Component({
  selector: 'morse-dialog',
  templateUrl: './dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './dialog.css',
})
export class Dialog {
  /** The id of the heading inside this dialog, so a reader is told what it is. */
  readonly labelledBy = input<string>();
  /** Its name, when the heading has no id to point at. Give one of the two. */
  readonly label = input<string>();
  /** The id of the sentence that says what confirming does, when it has one. */
  readonly describedBy = input<string>();
  /**
   * `alertdialog` only where a stray keystroke would do damage — `dialog` says the
   * same thing without interrupting a screen reader mid-sentence.
   */
  readonly role = input('dialog');

  /** The user asked to leave: the backdrop, or Escape. */
  readonly dismiss = output<void>();

  constructor() {
    const release = inject(OverlayStack).open(() => this.dismiss.emit());
    inject(DestroyRef).onDestroy(release);
  }
}
