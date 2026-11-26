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
import { BotFace } from '../../ui/bot-face/bot-face';
import type { BotMood } from '../../ui/bot-face/bot-face-moods';
import { moodForBot } from '../../ui/bot-face/bot-mood';
import { MorseService } from '../../host/morse.service';
import { ModePrefs } from '../../state/mode-prefs';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';

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
  // A `group` menu also serves a thread row: the row affordances are the same, and
  // the template hides the group-only management items for a thread.
  | (MenuAnchor & { kind: 'group'; group: BotConversationSummary; confirming: boolean });

/**
 * Bot mode's sidebar: the roster of isolated bots, the threads they opened between
 * themselves, the groups they talk in, and one place to add a bot or a group.
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
  imports: [BotFace],
  templateUrl: './bot-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bot-nav.css',
})
export class BotNav {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly prefs = inject(ModePrefs);
  private readonly tabs = inject(WorkspaceTabs);

  protected readonly bots = computed(() => this.morse.bot.roster()?.bots ?? []);
  /**
   * Bot definitions are an admin surface: creating, editing or deleting one
   * writes shared config (and reads bot env back), so regulars only chat.
   * On a single-user host `user` is null and there are no roles, so the
   * entries stay. The host enforces the same rule — this only hides the UI.
   */
  protected readonly manageAllowed = computed(
    () => this.morse.user() === null || this.morse.user()?.role === 'admin',
  );
  protected readonly groups = computed(() =>
    (this.morse.bot.roster()?.conversations ?? []).filter(
      (conversation) => conversation.kind === 'group',
    ),
  );
  /**
   * Side work two bots did between themselves. A thread is a real conversation the
   * reader may open and read; it simply has no group record behind it, so the
   * dialog that manages rooms does not apply.
   */
  protected readonly threads = computed(() =>
    (this.morse.bot.roster()?.conversations ?? []).filter(
      (conversation) => conversation.kind === 'thread',
    ),
  );
  /** The conversation in front, so its row reads as the open one. */
  protected readonly activeId = this.morse.bot.activeId;
  /**
   * Which conversations are mid-answer, so a row's destructive actions are held
   * while its bot is still working. Read as a map: several conversations can be
   * answering at once, and switching between them must not hide any of them.
   */
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

  /** The threads the search keeps: title or a member's name, as a room is found. */
  protected readonly threadMatches = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (needle.length === 0) {
      return this.threads();
    }
    return this.threads().filter(
      (thread) =>
        thread.title.toLowerCase().includes(needle) ||
        thread.members.some((member) => member.toLowerCase().includes(needle)),
    );
  });

  protected readonly filtering = computed(() => this.query().trim().length > 0);

  protected readonly createOpen = computed(() => this.menu()?.kind === 'create');

  constructor() {
    /*
     * Where the reader was, kept across a reload: the conversation in front is
     * written down as it changes, and a page that came back in bot mode reopens the
     * one it left — but only once the roster confirms it still exists. A bot or
     * group deleted while the page was closed is forgotten rather than restored
     * into an empty room.
     *
     * A roster arrives as a push, but nothing sends one until someone asks, so the
     * first look at an empty roster asks for it. `untracked` keeps those requests
     * from re-arming the effect: they change the same signals it watches.
     */
    effect(() => {
      const roster = this.morse.bot.roster();
      const active = this.morse.bot.activeId();
      if (roster === null) {
        untracked(() => this.morse.listBots());
        return;
      }
      if (active !== null) {
        untracked(() => this.prefs.rememberBotConversation(active));
        return;
      }
      const remembered = this.prefs.botConversation();
      if (remembered === null) {
        return;
      }
      const conversation = roster.conversations.find((one) => one.id === remembered);
      untracked(() => {
        if (conversation !== undefined) {
          this.tabs.openBotChat(conversation.id, conversation.title);
        } else {
          this.prefs.rememberBotConversation(null);
        }
      });
    });
  }

  /** Every bot mid-turn, anywhere: the roster's faces and the rooms agree. */
  private readonly answering = computed(() => {
    const handles = new Set<string>();
    for (const state of Object.values(this.morse.bot.routing())) {
      for (const active of state.active) {
        handles.add(active.username);
      }
    }
    return handles;
  });

  /**
   * What each bot's face is doing. A bot answering in any room is thinking, a
   * warm engine is work in progress; otherwise it rests on the face its own
   * description earned.
   */
  protected moodOf(bot: BotSummary): BotMood {
    return moodForBot({
      description: `${bot.name} ${bot.description}`,
      streaming: this.answering().has(bot.username),
      warm: bot.warm,
    });
  }

  /** A room's mark is the same letter idea, from its title. */
  protected roomMark(room: BotConversationSummary): string {
    return room.title.slice(0, 1).toUpperCase();
  }

  /** The second line of a bot row: what it is for, or failing that its handle. */
  protected botSubtitle(bot: BotSummary): string {
    return bot.description.trim().length > 0 ? bot.description : `@${bot.username}`;
  }

  /** The second line of a room row: who is in it, by display name. */
  protected roomSubtitle(room: BotConversationSummary): string {
    if (room.members.length === 0) {
      return 'No members';
    }
    return room.members.map((member) => this.displayNames().get(member) ?? member).join(', ');
  }

  /** True while this conversation has a bot answering, when acting on it would strand a turn. */
  protected routingForConversation(id: string): boolean {
    const state = this.routing()[id];
    return state !== undefined && (state.active.length > 0 || state.queued.length > 0);
  }

  /** True while this bot's own DM is answering, when deleting it would strand a turn. */
  protected routingFor(bot: BotSummary): boolean {
    return this.routingForConversation(`dm-${bot.username}`);
  }

  /**
   * The handles of the bots this room says are running. Routing carries both the
   * display name and the handle, and only the handle identifies a bot: display
   * names can repeat, handles cannot. The handles are returned as they arrive —
   * no matching back through the roster, which is what used to collapse two
   * same-named bots into the first one.
   */
  protected activeMembers(group: BotConversationSummary): string[] {
    return (this.routing()[group.id]?.active ?? []).map((one) => one.username);
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

  protected threadsEmpty(): string {
    if (this.filtering()) {
      return 'No threads match.';
    }
    return 'No threads yet.';
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
        : { kind: 'group', group: target, confirming: false, ...point },
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
        : { kind: 'group', group: target, confirming: false, ...point },
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

  /** A group's delete is destructive too, so it asks in the menu first. */
  protected askDeleteGroup(group: BotConversationSummary): void {
    const open = this.menu();
    if (open === undefined) {
      return;
    }
    this.menu.set({ ...open, kind: 'group', group, confirming: true });
  }

  protected deleteGroupNow(group: BotConversationSummary): void {
    this.closeMenu();
    this.morse.deleteGroup(group.id);
    this.shell.closeNavigation();
  }

  /** A thread's delete asks the same way: it takes the room and its history. */
  protected askDeleteThread(thread: BotConversationSummary): void {
    const open = this.menu();
    if (open === undefined) {
      return;
    }
    this.menu.set({ ...open, kind: 'group', group: thread, confirming: true });
  }

  protected deleteThreadNow(thread: BotConversationSummary): void {
    this.closeMenu();
    this.morse.deleteThread(thread.id);
    this.shell.closeNavigation();
  }

  protected startDiscussion(conversationId: string): void {
    this.closeMenu();
    this.morse.newBotDiscussion(conversationId);
  }

  /** Stops one bot in the conversation whose menu this is. */
  protected stopBot(conversationId: string, username: string): void {
    this.closeMenu();
    this.morse.stopBotRound(conversationId, username);
  }

  /** A DM holds one bot, so its stop needs no name in the menu. */
  protected stopDm(bot: BotSummary): void {
    this.stopBot(`dm-${bot.username}`, bot.username);
  }

  /**
   * Every "New bot" is its own editor tab, so several can be drafted before any
   * is saved — closing one form never takes the others with it.
   */
  protected newBot(): void {
    this.closeMenu();
    this.tabs.openBotEditor(null, 'New bot');
    this.morse.ui.wizardTarget.set(null);
    this.morse.ui.wizardOpen.set(true);
  }

  /** Opens the same editor on its own tab, loaded with this bot's record. */
  protected editBot(bot: BotSummary): void {
    this.closeMenu();
    this.morse.inspectBot(bot.username);
    this.tabs.openBotEditor(bot.username, `Edit ${bot.name}`);
    this.morse.ui.wizardTarget.set(bot.username);
    this.morse.ui.wizardOpen.set(true);
  }

  /** Opens the group dialog on this group's own record. */
  protected editGroup(group: BotConversationSummary): void {
    this.closeMenu();
    this.morse.ui.groupTarget.set(group.id);
    this.morse.ui.groupOpen.set(true);
  }

  protected newGroup(): void {
    this.closeMenu();
    this.morse.ui.groupTarget.set(null);
    this.morse.ui.groupOpen.set(true);
  }

  protected openBot(bot: BotSummary): void {
    this.tabs.openBotChat(`dm-${bot.username}`, bot.name);
    this.shell.closeNavigation();
  }

  protected openRoom(room: BotConversationSummary): void {
    this.tabs.openBotChat(room.id, room.title);
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
