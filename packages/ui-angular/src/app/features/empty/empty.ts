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
  templateUrl: './empty.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './empty.css',
})
export class EmptySession {
  /** Whether a session tab is open behind this panel, so the hint can say so. */
  readonly hasTabs = input(false);
  readonly create = output<void>();
}
