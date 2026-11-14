import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { BotConversationSummary, BotSummary } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';

/** An anchor point for a menu, already clamped inside the viewport. */
interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * The one menu this sidebar opens: the creation list, or the actions of the row
 * that was right-clicked (or reached through its `⋯`). A bot's delete asks for
 * confirmation inside the menu, the way the session list does — a row is a
 * button (open the conversation), so a destructive action must not be a second
 * click target inside it.
 */
type NavMenu =
  | (MenuAnchor & { kind: 'create' })
  | (MenuAnchor & { kind: 'bot'; bot: BotSummary; confirming: boolean })
  | (MenuAnchor & { kind: 'group'; group: BotConversationSummary });

/**
 * Bot mode's sidebar: the roster of isolated bots, the groups they talk in, and
 * one place to add either.
 *
 * It owns no state of its own — the roster, the conversation in front and the
 * creation dialogs all live behind `MorseService` — so it is the same shape as
 * the session list: rows that open a conversation, the open one marked, actions
 * behind a right-click, and a search box for when the roster outgrows the panel.
 * Opening is a shell gesture (a drawer closes behind it), which is why it also
 * asks `ShellState`.
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

  /** What the reader typed into the search box; empty means "everything". */
  protected readonly query = signal('');
  protected readonly menu = signal<NavMenu | undefined>(undefined);

  /** The bots the search keeps: name, handle, description or engine. */
  protected readonly botMatches = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (needle.length === 0) {
      return this.bots();
    }
    return this.bots().filter(
      (bot) =>
        bot.name.toLowerCase().includes(needle) ||
        bot.username.toLowerCase().includes(needle) ||
        bot.description.toLowerCase().includes(needle) ||
        bot.engineKind.toLowerCase().includes(needle),
    );
  });

  /** Member usernames → the names the reader knows them by. */
  private readonly displayNames = computed(() => {
    const bots = this.morse.bot.roster()?.bots ?? [];
    return new Map(bots.map((bot) => [bot.username, bot.name] as const));
  });

  /** The groups the search keeps: title or a member's name. */
  protected readonly groupMatches = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (needle.length === 0) {
      return this.groups();
    }
    return this.groups().filter(
      (group) =>
        group.title.toLowerCase().includes(needle) ||
        group.members.some((member) => member.toLowerCase().includes(needle)),
    );
  });

  protected readonly filtering = computed(() => this.query().trim().length > 0);

  protected readonly createOpen = computed(() => this.menu()?.kind === 'create');

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

  /** The second line of a bot row: what it is for, or failing that its handle. */
  protected botSubtitle(bot: BotSummary): string {
    return bot.description.trim().length > 0 ? bot.description : `@${bot.username}`;
  }

  /** The second line of a group row: who is in it, by display name. */
  protected groupSubtitle(group: BotConversationSummary): string {
    if (group.members.length === 0) {
      return 'No members';
    }
    return group.members.map((member) => this.displayNames().get(member) ?? member).join(', ');
  }

  /** True while this bot's own DM is answering, when deleting it would strand a turn. */
  protected routingFor(bot: BotSummary): boolean {
    return this.routing()?.conversationId === `dm-${bot.username}`;
  }

  /** The empty line a section shows: nothing yet, still loading, or nothing matching. */
  protected botsEmpty(): string {
    if (this.filtering()) {
      return 'No bots match.';
    }
    return this.loaded() ? 'No bots yet.' : 'Loading bots…';
  }

  protected groupsEmpty(): string {
    if (this.filtering()) {
      return 'No groups match.';
    }
    return this.loaded() ? 'No groups yet.' : 'Loading groups…';
  }

  protected setQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected clearQuery(): void {
    this.query.set('');
  }

  /**
   * The creation menu hangs off the `+` button: one control, two entries, and
   * the search box keeps the width the two old side-by-side buttons took.
   */
  protected toggleCreate(event: MouseEvent): void {
    if (this.createOpen()) {
      this.closeMenu();
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ kind: 'create', ...this.anchorAt(rect.right, rect.bottom + 4, 168, 84) });
  }

  /** A right-click on a row opens that row's menu at the pointer. */
  protected openRowMenu(event: MouseEvent, target: BotSummary | BotConversationSummary): void {
    event.preventDefault();
    event.stopPropagation();
    const point = this.anchorAt(event.clientX, event.clientY, 208, 132);
    this.menu.set(
      'engineKind' in target
        ? { kind: 'bot', bot: target, confirming: false, ...point }
        : { kind: 'group', group: target, ...point },
    );
  }

  /** The `⋯` opens the same menu, anchored under itself. */
  protected openMoreMenu(event: MouseEvent, target: BotSummary | BotConversationSummary): void {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const point = this.anchorAt(rect.right, rect.bottom + 4, 208, 132);
    this.menu.set(
      'engineKind' in target
        ? { kind: 'bot', bot: target, confirming: false, ...point }
        : { kind: 'group', group: target, ...point },
    );
  }

  protected closeMenu(): void {
    this.menu.set(undefined);
  }

  /** A bot's delete is destructive, so the menu asks before anything happens. */
  protected askDelete(bot: BotSummary): void {
    const open = this.menu();
    if (open === undefined) {
      return;
    }
    this.menu.set({ ...open, kind: 'bot', bot, confirming: true });
  }

  protected deleteNow(bot: BotSummary): void {
    this.closeMenu();
    this.morse.deleteBot(bot.username);
    this.shell.closeNavigation();
  }

  protected startDiscussion(conversationId: string): void {
    this.closeMenu();
    this.morse.newBotDiscussion(conversationId);
  }

  protected newBot(): void {
    this.closeMenu();
    this.morse.ui.wizardTarget.set(null);
    this.morse.ui.wizardOpen.set(true);
  }

  /** Opens the same wizard with this bot's own record loaded into it. */
  protected editBot(bot: BotSummary): void {
    this.closeMenu();
    this.morse.inspectBot(bot.username);
    this.morse.ui.wizardTarget.set(bot.username);
    this.morse.ui.wizardOpen.set(true);
  }

  protected newGroup(): void {
    this.closeMenu();
    this.morse.ui.groupOpen.set(true);
  }

  protected openBot(bot: BotSummary): void {
    this.open(`dm-${bot.username}`);
  }

  protected openGroup(group: BotConversationSummary): void {
    this.open(group.id);
  }

  private open(id: string): void {
    this.morse.openBotConversation(id);
    this.shell.closeNavigation();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.menu() !== undefined) {
      this.closeMenu();
    }
  }

  /**
   * A menu is drawn at the pointer but kept inside the window: the sidebar is
   * narrow and a row can sit near the bottom edge.
   */
  private anchorAt(x: number, y: number, width: number, height: number): MenuAnchor {
    return {
      x: Math.max(4, Math.min(x - width, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    };
  }
}
