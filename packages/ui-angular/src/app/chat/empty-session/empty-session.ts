import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * What the chat column shows when **no session tab is in front**: no hero, no
 * transcript, no composer — a conversation has to exist before one can be had.
 *
 * The Morse wordmark used to stand in here, which read as "the agent is ready,
 * type away" while the panel was in fact holding nothing. This says the truth
 * instead, and the one button is the same "New session" the sidebar offers.
 */
@Component({
  selector: 'morse-empty-session',
  templateUrl: './empty-session.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        flex: 1;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .empty-session {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        max-width: 380px;
        text-align: center;
      }
      .mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        margin-bottom: 4px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        color: var(--morse-fg-muted);
      }
      .mark svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.4;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      p {
        margin: 0;
        color: var(--morse-fg-muted);
        font-size: 12.5px;
        line-height: 1.55;
      }
      button {
        margin-top: 10px;
        padding: 6px 14px;
        border: 1px solid var(--morse-accent);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-accent);
        color: var(--morse-accent-fg, #fff);
        font: inherit;
        font-size: 12.5px;
        cursor: pointer;
      }
      button:hover:not(:disabled) {
        background: var(--morse-accent-hover);
        border-color: var(--morse-accent-hover);
      }
    `,
  ],
})
export class EmptySession {
  /** Whether a session tab is open behind this panel, so the hint can say so. */
  readonly hasTabs = input(false);
  readonly create = output<void>();
}
