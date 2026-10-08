import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Dialog } from './dialog/dialog';

/**
 * A yes/no gate for an action that cannot be taken back.
 *
 * Compaction is the first user: it spends a model call and replaces what the agent
 * remembers from then on, and a single stray click on the header was enough to
 * start it. So the dialog opens with **Cancel focused** — the keystroke that opened
 * it (Enter in the composer, or the click that landed here by accident) must not
 * also be able to confirm it. Escape and the backdrop cancel, because the safe
 * direction is always one action away.
 *
 * It renders nothing but the question: the caller owns what happens next, so the
 * same dialog can guard anything (see `ShellState.requestCompact`).
 */
@Component({
  selector: 'morse-confirm-dialog',
  templateUrl: './confirm-dialog.html',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './confirm-dialog.css',
})
export class ConfirmDialog {
  /** The question itself, e.g. "Compact the conversation?". */
  readonly title = input.required<string>();
  /** What the action does, in the user's terms. */
  readonly body = input('');
  /** What cannot be undone about it. */
  readonly note = input('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancel');

  constructor() {
    // The dialog is created by the click we are guarding against, so focus goes to
    // the button that does nothing. Deferred a tick because the view child arrives
    // with the render this effect is part of.
    effect(() => {
      const button = this.cancelButton()?.nativeElement;
      if (button) {
        setTimeout(() => button.focus(), 0);
      }
    });
  }
}
