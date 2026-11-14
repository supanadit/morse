import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type {
  BotAuthor,
  BotConversationSummary,
  BotTranscriptEntry,
  PromptImage,
} from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { ComposerDrafts } from '../../state/composer-drafts';
import { Markdown } from '../../ui/markdown/markdown';
import { ChatComposer, type BotComposerSend } from '../composer/composer';
import type { MentionCandidate } from '../mention-picker/mention-picker';

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
  private readonly drafts = inject(ComposerDrafts);
  private readonly scrollHost = viewChild<ElementRef<HTMLElement>>('scroll');
  private readonly dockElement = viewChild<ElementRef<HTMLElement>>('dock');
  /** The floating composer's measured height, exposed as `--morse-dock-height`. */
  protected readonly dockHeight = signal(0);

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
  /** Whether the host said older entries exist before the ones held. */
  protected readonly hasOlder = computed(() => {
    const id = this.morse.bot.activeId();
    return id === null ? false : this.morse.bot.hasOlder()[id] === true;
  });
  /** True while a page of older entries is in flight, so the row says so. */
  protected readonly loadingOlder = signal(false);

  /**
   * The round in flight, and only when it belongs to the conversation in front:
   * a bot still answering in another room must not draw a row here.
   */
  protected readonly routing = computed(() => {
    const routing = this.morse.bot.routing();
    return routing !== null && routing.conversationId === this.morse.bot.activeId()
      ? routing
      : null;
  });

  /**
   * The one line of presence the chat shows while a bot works — "Reading
   * launch-brief.md" — where its answer will appear.
   *
   * A chat has presence, not a trace: the row is replaced as the bot moves on and
   * gone when the answer lands, so it never enters the transcript the host keeps.
   * `key` changes with every new activity, which is what makes Angular rebuild the
   * node and replay the animation instead of quietly swapping the words.
   */
  protected readonly acting = computed<
    {
      key: string;
      kind: string;
      label: string;
      name: string;
      mark: string;
      queued: string[];
    }[]
  >(() => {
    const routing = this.routing();
    const name = routing?.target;
    if (routing === null || name === undefined) {
      return [];
    }
    const activity = routing.activity;
    const bot = this.morse.bot.roster()?.bots.find((one) => one.name === name);
    return [
      {
        key: activity === undefined ? `waiting:${name}` : `${activity.kind}:${activity.at}`,
        kind: activity?.kind ?? 'starting',
        // No activity yet means the engine is still being started, which is its
        // own kind of waiting and worth saying rather than showing nothing.
        label: activity?.label ?? 'Getting started…',
        name,
        mark: bot?.avatar ?? name.slice(0, 1).toUpperCase(),
        queued: routing.queued,
      },
    ];
  });

  constructor() {
    /*
     * A bot conversation's draft — its words and its attachments — is its own.
     * The composer's draft store is keyed by the tab in front, which in bot mode is
     * still whatever code session is open behind it; without this, half a bot
     * message and the screenshot attached to it would turn up in that session's
     * composer and ride along with a prompt it has nothing to do with.
     *
     * The conversation id is read before the guard so this effect has something to
     * watch: it is the tracked dependency, and the key is rebuilt whenever the
     * reader opens another room.
     */
    effect((onCleanup) => {
      const conversationId = this.morse.bot.activeId();
      if (conversationId === null) {
        return;
      }
      const release = untracked(() => this.drafts.pinDraft(`bot:${conversationId}`));
      onCleanup(release);
    });
    /*
     * The transcript reserves the floating composer's height at its end, so the
     * last line is never behind the glass. Measured rather than a constant: the
     * slab grows with a long draft or an attachments row, and a fixed pad would be
     * wrong by exactly the amount that matters. Same mechanism as code mode's dock.
     */
    effect((onCleanup) => {
      const dock = this.dockElement()?.nativeElement;
      if (!dock || typeof ResizeObserver === 'undefined') {
        this.dockHeight.set(0);
        return;
      }
      const observer = new ResizeObserver(() => {
        this.dockHeight.set(Math.round(dock.getBoundingClientRect().height));
      });
      observer.observe(dock);
      onCleanup(() => observer.disconnect());
    });
    // Follow the newest line, the way a chat does. Corrected after render: the
    // new entry has to be in the DOM before there is a bottom to reach.
    effect(() => {
      const count = this.entries().length;
      const last = this.entries().at(-1)?.id;
      untracked(() => {
        // A page prepended by scrolling up must not yank the reader back down.
        if (this.loadingOlder()) {
          this.loadingOlder.set(false);
          return;
        }
        if (count === 0 || last === undefined) {
          return;
        }
        setTimeout(() => {
          const host = this.scrollHost()?.nativeElement;
          if (host) {
            host.scrollTop = host.scrollHeight;
          }
        }, 0);
      });
    });
    // The presence row is worth seeing the moment it appears — but only for a
    // reader already at the end: someone reading history must not be pulled down
    // every time a tool the bot runs changes the words.
    effect(() => {
      const key = this.acting()[0]?.key;
      untracked(() => {
        if (key === undefined) {
          return;
        }
        const host = this.scrollHost()?.nativeElement;
        if (host !== undefined && host.scrollHeight - host.scrollTop - host.clientHeight < 160) {
          host.scrollTop = host.scrollHeight;
        }
      });
    });
  }

  /** The divider's wall-clock time, so a boundary is placeable in the day. */
  protected when(at: number): string {
    return new Date(at).toLocaleString();
  }

  protected stamp(at: number): string {
    return new Date(at).toISOString();
  }

  /** A bot's mark: its own avatar when it has one, else the letter it starts with. */
  protected mark(author: BotAuthor & { role: 'bot' }): string {
    return author.avatar ?? author.name.slice(0, 1).toUpperCase();
  }

  /**
   * The members a `@` can address: every bot in the conversation, in roster order,
   * with the handle the host routes on and the name the reader knows it by.
   *
   * A handle is the only thing the host parses — the display name is free text —
   * and nobody remembers `@job-hunter` on sight, so the list carries both.
   */
  protected readonly mentionMembers = computed<MentionCandidate[]>(() => {
    const conversation = this.conversation();
    const roster = this.morse.bot.roster();
    if (conversation === undefined || roster === null) {
      return [];
    }
    const order = new Map(conversation.members.map((member, index) => [member, index]));
    return roster.bots
      .filter((bot) => order.has(bot.username))
      .sort((left, right) => (order.get(left.username) ?? 0) - (order.get(right.username) ?? 0))
      .map((bot) => ({
        username: bot.username,
        name: bot.name,
        ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
        ...(bot.description.length === 0 ? {} : { description: bot.description }),
      }));
  });
  /**
   * `@all` / `@everyone` belong in a room with more than one bot. In a direct
   * message they would address the only member, which is what a plain line does.
   */
  protected readonly canBroadcast = computed(() =>
    this.conversation()?.kind === 'group' ? this.mentionMembers().length > 1 : false,
  );

  /** A group's members by display name: the row is for the reader, not for keys. */
  protected memberNames(conversation: BotConversationSummary): string {
    const names = new Map(this.morse.bot.roster()?.bots.map((bot) => [bot.username, bot.name]));
    return conversation.members.map((member) => names.get(member) ?? member).join(', ');
  }

  /**
   * Scroll-to-top paging: near the top, ask for the page before the oldest entry
   * held. `loadingOlder` keeps one request in flight, so a scroll gesture cannot
   * ask twice; the host's answer clears it.
   */
  protected onScroll(event: Event): void {
    const host = event.target as HTMLElement;
    if (host.scrollTop > 48 || !this.hasOlder() || this.loadingOlder()) {
      return;
    }
    const id = this.morse.bot.activeId();
    const oldest = this.entries()[0];
    if (id === null || oldest === undefined) {
      return;
    }
    this.loadingOlder.set(true);
    this.morse.loadOlderBotHistory(id, oldest.id);
  }

  /** The reader's line, with whatever they attached, on its way to the host. */
  protected send(line: BotComposerSend): void {
    this.morse.sendBotMessage(line.text, line.images, line.files);
  }

  /** A sent image's `data:` URL, for the thumbnail in the reader's own bubble. */
  protected preview(image: PromptImage): string {
    return `data:${image.mimeType};base64,${image.data}`;
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
