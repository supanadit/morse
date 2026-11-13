import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import type { BotConversationSummary, BotSummary } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';

/**
 * Bot mode's sidebar: the roster of isolated bots, the groups they talk in, and
 * the two ways to add one.
 *
 * It owns no state of its own — the roster, the conversation in front and the
 * creation dialogs all live behind `MorseService` — so it is the same shape as
 * the session list: rows that open a conversation, with the open one marked.
 * Opening is a shell gesture (a drawer closes behind it), which is why the click
 * also asks `ShellState`.
 */
@Component({
  selector: 'morse-bot-nav',
  templateUrl: './bot-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bot-nav.css',
})
export class BotNav {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);

  protected readonly bots = computed(() => this.morse.bot.roster()?.bots ?? []);
  protected readonly groups = computed(() =>
    (this.morse.bot.roster()?.conversations ?? []).filter(
      (conversation) => conversation.kind === 'group',
    ),
  );
  /** The conversation in front, so its row reads as the open one. */
  protected readonly activeId = this.morse.bot.activeId;
  /** The round the host is running, so a bot mid-answer is not deletable. */
  protected readonly routing = this.morse.bot.routing;
  /**
   * A roster arrives as a push, but nothing sends one until someone asks — so
   * the first look at an empty roster asks for it. `untracked` keeps the reply
   * from re-arming the effect: it is the same signal the push changes.
   */
  protected readonly loaded = computed(() => this.morse.bot.roster() !== null);

  constructor() {
    effect(() => {
      if (this.morse.bot.roster() === null) {
        untracked(() => this.morse.listBots());
      }
    });
  }

  /** A bot's mark: its own avatar when it has one, else the letter it starts with. */
  protected mark(bot: BotSummary): string {
    return bot.avatar ?? bot.name.slice(0, 1).toUpperCase();
  }

  /** A group's mark is the same letter idea, from its title. */
  protected groupMark(group: BotConversationSummary): string {
    return group.title.slice(0, 1).toUpperCase();
  }

  /** True while this bot's own DM is answering, when deleting it would strand a turn. */
  protected routingFor(bot: BotSummary): boolean {
    return this.routing()?.conversationId === `dm-${bot.name}`;
  }

  /**
   * Deletes a bot and its tree. Destructive and confirm-first: the bot's config,
   * sessions and workspace are removed, so the reader is told exactly that
   * before anything happens.
   */
  protected deleteBot(bot: BotSummary): void {
    const confirmed = window.confirm(
      `Delete bot ${bot.name}? Its config, sessions and workspace are removed.`,
    );
    if (!confirmed) {
      return;
    }
    this.morse.deleteBot(bot.name);
    this.shell.closeNavigation();
  }

  protected openBot(bot: BotSummary): void {
    this.open(`dm-${bot.name}`);
  }

  protected openGroup(group: BotConversationSummary): void {
    this.open(group.id);
  }

  private open(id: string): void {
    this.morse.openBotConversation(id);
    this.shell.closeNavigation();
  }

  /** The wizard is a shell-level dialog; the sidebar only asks for it. */
  protected newBot(): void {
    this.morse.ui.wizardOpen.set(true);
  }

  protected newGroup(): void {
    this.morse.ui.groupOpen.set(true);
  }
}
