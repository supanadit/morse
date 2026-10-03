import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgb(0 0 0 / 45%);
      }
      .modal-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(420px, 100%);
        padding: 16px 18px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        animation: confirm-in 140ms ease-out;
      }
      h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .body {
        margin: 0;
        font-size: 12.5px;
        line-height: 1.6;
      }
      /* The consequence gets its own line, in warning colours: it is the reason
         the question is being asked at all. */
      .note {
        margin: 0;
        color: var(--morse-warn);
        font-size: 11.5px;
        line-height: 1.55;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 2px;
      }
      @keyframes confirm-in {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .modal-card {
          animation: none;
        }
      }
    `,
  ],
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

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.cancelled.emit();
  }
}
