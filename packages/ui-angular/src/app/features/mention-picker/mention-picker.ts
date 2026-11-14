import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { EnterDirective } from '../../ui/enter.directive';

/** One bot a message can address: its handle, what it is called, and its mark. */
export interface MentionCandidate {
  /** The handle the host parses: `@forge`, and what an insertion writes. */
  username: string;
  /** The display name, shown beside the handle the way a chat shows both. */
  name: string;
  /** The bot's own avatar, when it has one; otherwise its initial. */
  avatar?: string;
  /** What it is for, under a group member's name. */
  description?: string;
}

/**
 * The bot-conversation `@` list: who is in this room and can be addressed.
 *
 * A bot chat has nothing in common with the file picker except the key that opens
 * it — the rows are teammates, not paths — so this is its own component rather
 * than a mode of that one. It is *presentational* on purpose: the composer owns
 * the query, the highlight and the keyboard, so the caret never leaves the prompt
 * and a half-typed `@jo` is still text the reader can edit.
 *
 * The layout follows what a chat reader already knows (Mattermost, Slack,
 * Discord): the people first, then the words that address more than one of them,
 * each row a handle in bold with the name that belongs to it.
 */
@Component({
  selector: 'morse-mention-picker',
  imports: [EnterDirective],
  templateUrl: './mention-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './mention-picker.css',
})
export class MentionPicker {
  /** The already-ranked members to show; the composer owns the filtering. */
  readonly members = input.required<readonly MentionCandidate[]>();
  /**
   * Words that address everyone (`@all`, `@everyone`). Off in a one-to-one room,
   * where there is nobody to broadcast to.
   */
  readonly broadcast = input(false);
  /** The query typed after `@`, only used to phrase the empty state. */
  readonly query = input('');
  /** Highlighted row index, owned by the composer so the prompt keeps the keys. */
  readonly active = input(0);

  /** A handle was chosen: `forge`, `all`, … — the composer writes `@forge`. */
  readonly pick = output<string>();
  readonly activeChange = output<number>();
  readonly close = output<void>();

  /** Where the member rows end and the broadcast rows begin. */
  protected readonly broadcastRows: readonly { handle: string; hint: string }[] = [
    { handle: 'all', hint: 'Addresses every bot in this conversation' },
    { handle: 'everyone', hint: 'The same as @all' },
  ];

  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  constructor() {
    // The composer keeps the keyboard, so nothing scrolls the list on its own and
    // the highlighted row can sit below the fold. Reveal it once the DOM settles.
    effect(() => {
      this.active();
      this.members();
      setTimeout(() => this.revealActive(), 0);
    });
  }

  /** A bot's mark: its avatar when it has one, else the letter it starts with. */
  protected mark(member: MentionCandidate): string {
    return member.avatar ?? member.name.slice(0, 1).toUpperCase();
  }

  /** Nudges the active row into the list viewport without scrolling the page. */
  private revealActive(): void {
    const container = this.list()?.nativeElement;
    if (!container) {
      return;
    }
    const rows = [...container.querySelectorAll<HTMLElement>('.row')];
    const row = rows[this.active()];
    if (row === undefined) {
      return;
    }
    const view = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < view.top) {
      container.scrollTop -= view.top - rect.top;
    } else if (rect.bottom > view.bottom) {
      container.scrollTop += rect.bottom - view.bottom;
    }
  }
}
