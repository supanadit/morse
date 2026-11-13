import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import type { BotAuthor, BotConversationSummary, BotTranscriptEntry } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { Markdown } from '../../ui/markdown/markdown';
import { ChatComposer } from '../composer/composer';

/**
 * Bot mode's conversation: the lines of the DM or group in front, who said
 * them, and the round the host is running.
 *
 * It owns no state of its own. The transcript, the open conversation and the
 * route live in `BotState`, behind `MorseService`, so this is a view of those
 * signals with one gesture each: send a line, stop the round, start a new
 * discussion. It reuses the same markdown renderer as the code transcript and
 * the same composer — with the session's machinery switched off — so a reader
 * does not learn a second chat.
 */
@Component({
  selector: 'morse-bot-chat',
  templateUrl: './bot-chat.html',
  imports: [Markdown, ChatComposer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bot-chat.css',
})
export class BotChat {
  protected readonly morse = inject(MorseService);
  private readonly scrollHost = viewChild<ElementRef<HTMLElement>>('scroll');

  /** The conversation in front, named from the roster; `undefined` before one opens. */
  protected readonly conversation = computed<BotConversationSummary | undefined>(() => {
    const id = this.morse.bot.activeId();
    if (id === null) {
      return undefined;
    }
    return this.morse.bot.roster()?.conversations.find((conversation) => conversation.id === id);
  });
  /** The lines held for it, in the order the host sent them. */
  protected readonly entries = computed<BotTranscriptEntry[]>(() => {
    const id = this.morse.bot.activeId();
    return id === null ? [] : (this.morse.bot.transcripts()[id] ?? []);
  });
  /**
   * The round in flight, and only when it belongs to the conversation in front:
   * a bot still answering in another room must not put "Asking …" over this one.
   */
  protected readonly routing = computed(() => {
    const routing = this.morse.bot.routing();
    return routing !== null && routing.conversationId === this.morse.bot.activeId()
      ? routing
      : null;
  });

  constructor() {
    // Follow the newest line, the way a chat does. Corrected after render: the
    // new entry has to be in the DOM before there is a bottom to reach.
    effect(() => {
      this.entries();
      untracked(() => {
        setTimeout(() => {
          const host = this.scrollHost()?.nativeElement;
          if (host) {
            host.scrollTop = host.scrollHeight;
          }
        }, 0);
      });
    });
  }

  /** A bot's mark: its own avatar when it has one, else the letter it starts with. */
  protected mark(author: BotAuthor & { role: 'bot' }): string {
    return author.avatar ?? author.name.slice(0, 1).toUpperCase();
  }

  /** The round's Stop: aborts the turn in flight and drops the queued relays. */ protected stop(): void {
    this.morse.stopBotRound();
  }

  /**
   * A new discussion keeps the room and its lines but starts every member on a
   * fresh engine session — a deliberate, irreversible break in what the bots
   * remember, so it asks first.
   */
  protected newDiscussion(): void {
    const confirmed = confirm(
      'Start a new discussion? Every bot in this conversation starts a fresh engine session. The history in this window stays.',
    );
    if (!confirmed) {
      return;
    }
    this.morse.newBotDiscussion();
  }
}
