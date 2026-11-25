import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type {
  BotActivity,
  BotAuthor,
  BotConversationSummary,
  BotHandoff,
  BotSummary,
  BotTranscriptEntry,
  BotTurnReply,
  BotUsage,
  PromptImage,
} from '@morse/protocol';
import { clockTime, fullTime } from '@morse/ui-runtime';
import { BotFace } from '../../ui/bot-face/bot-face';
import type { BotMood } from '../../ui/bot-face/bot-face-moods';
import { moodForBot } from '../../ui/bot-face/bot-mood';
import { MorseService } from '../../host/morse.service';
import { ComposerDrafts } from '../../state/composer-drafts';
import { CopyButton } from '../../ui/copy-button/copy-button';
import { Markdown } from '../../ui/markdown/markdown';
import { ChatComposer, type BotComposerSend } from '../composer/composer';
import { botUsageInputs, hasBotUsage, type BotUsageInputs } from '../composer/bot-usage';
import type { MentionCandidate } from '../mention-picker/mention-picker';
import { UsageIndicator } from '../usage/usage-indicator';
import { elapsedLabel, revealLength, rowIsQuiet } from './reveal';
import { overlapWithRevealed, sentenceCase, visibleSteps } from './bot-chat-helpers';

/** How often an answer still arriving is revealed by one step. */
const REVEAL_INTERVAL_MS = 50;
/** How often the live row re-reads the clock under its elapsed time. */
const CLOCK_INTERVAL_MS = 1_000;

/**
 * One bot working right now, as its row draws it: the current step, how long the
 * turn has run, the work behind it, the words written so far and the bots it asked.
 */
interface ActingRow {
  /** The turn's identity: the row is rebuilt when the bot starts another turn. */
  key: string;
  /** The same turn, used to remember whether its step list is open. */
  turnKey: string;
  kind: BotActivity['kind'];
  label: string;
  name: string;
  /** Its own avatar, when the roster has one: the row wears the same face. */
  avatar: string;
  queued: string[];
  /** The bot's handle: unique, and the only thing a stop takes. */
  username: string;
  /** When the turn was taken off the queue, for the row's elapsed count. */
  startedAt: number;
  /** The newest step's epoch milliseconds: the quiet read counts from here. */
  lastStepAt: number;
  /** Whether any step is still running, which keeps the row from going quiet. */
  runningTool: boolean;
  /** How many steps the turn has taken, for the chevron's count. */
  stepCount: number;
  /** The newest three steps, oldest first, behind the row's chevron. */
  steps: BotActivity[];
  /** The answer so far, as text; never absent once the row exists. */
  partial: string;
  handoffs: BotHandoff[];
  /** This bot's own counters, so its row's ring describes its own window. */
  ring?: BotUsageInputs;
}

/**
 * What one bot has had revealed, and which turn it belongs to.
 *
 * The host keeps only the tail of a long answer, so the window a later push
 * carries can start part-way through words already on screen. The cursor keeps
 * the revealed text itself, not just an index into the current window, so a
 * sliding window never makes the answer shrink or start over.
 */
interface RevealCursor {
  /** The turn this cursor belongs to; another turn starts the words over. */
  turnKey: string;
  /** How many characters of the current partial the on-screen text accounts for. */
  shown: number;
  /** What is on screen: the revealed prefix, which never shortens mid-turn. */
  revealed: string;
}

/**
 * Bot mode's conversation: the lines of the DM or group in front, who said
 * them, and the round the host is running.
 *
 * It owns no state of its own. The transcript, the open conversation and the
 * route live in `BotState`, behind `MorseService`, so this is a view of those
 * signals with one gesture each: send a line, stop a bot's turn, start a new
 * discussion. It reuses the same markdown renderer as the code transcript and
 * the same composer — with the session's machinery switched off — so a reader
 * does not learn a second chat.
 */
@Component({
  selector: 'morse-bot-chat',
  templateUrl: './bot-chat.html',
  imports: [BotFace, Markdown, ChatComposer, CopyButton, UsageIndicator],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bot-chat.css',
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
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
  /** The roster carries this across refreshes and other devices on this host. */
  protected readonly compacting = computed(() => this.conversation()?.compacting === true);
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
  /** The peers' messages the reader has opened, by the turn that received them. */
  private readonly openPeers = signal<ReadonlySet<string>>(new Set<string>());
  /**
   * The header's overflow menu, open on a phone: where Compact, New discussion
   * and Clear messages live when the room-wide buttons do not fit beside the
   * title. Desktop keeps the row and never opens this.
   */
  protected readonly menuOpen = signal(false);

  private readonly element = inject(ElementRef);

  /** A click anywhere outside this component closes the phone's overflow menu. */
  protected onDocumentClick(event: Event): void {
    if (this.menuOpen() && !this.element.nativeElement.contains(event.target)) {
      this.menuOpen.set(false);
    }
  }

  /**
   * What the header face is computed from: the DM bot's handle, so the header
   * wears the same face as its roster tile.
   */
  protected headSeed(conversation: BotConversationSummary): string {
    return this.headBot(conversation)?.username ?? conversation.title;
  }

  /**
   * A DM is one bot talking to one reader, and its face is in the header: a
   * face on every line repeats the same picture all the way down. A room keeps
   * them, because there the avatar is what says who spoke.
   */
  protected readonly isDm = computed(() => this.conversation()?.kind === 'dm');

  /** The header's face: the DM bot's own avatar when it has one. */
  protected headAvatarValue(conversation: BotConversationSummary): string {
    return this.headBot(conversation)?.avatar ?? '';
  }

  /** The header face's mood: answering here turns it thoughtful, a failure sours it. */
  protected headMood(): BotMood {
    const conversation = this.conversation();
    const bot = conversation === undefined ? undefined : this.headBot(conversation);
    return moodForBot({
      description: bot === undefined ? '' : `${bot.name} ${bot.description}`,
      streaming: this.routing() !== null,
      warm: bot?.warm === true,
    });
  }

  private headBot(conversation: BotConversationSummary): BotSummary | undefined {
    if (conversation.kind !== 'dm') {
      return undefined;
    }
    const member = conversation.members[0];
    return this.morse.bot.roster()?.bots.find((candidate) => candidate.username === member);
  }

  /**
   * The round in flight, and only when it belongs to the conversation in front:
   * a bot still answering in another room must not draw a row here.
   *
   * Read from the per-conversation map, so leaving and coming back finds the row
   * exactly as the host last reported it — the round never stopped just because
   * the reader looked at something else.
   */
  protected readonly routing = computed(() => {
    const id = this.morse.bot.activeId();
    return id === null ? null : (this.morse.bot.routing()[id] ?? null);
  });

  /**
   * What the open conversation's most recent answer cost, for the composer's one
   * context ring; `undefined` until a bot has answered there. The room's other
   * bots report their own counters, which their presence rows draw.
   */
  protected readonly usage = computed<BotUsage | undefined>(() => {
    const id = this.morse.bot.activeId();
    return id === null ? undefined : this.morse.bot.latestUsage(id);
  });

  /**
   * One live row per bot working right now — what it is doing, how long it has
   * run, the steps behind it, the answer appearing as it is written and the bots
   * it asked.
   *
   * A chat has presence, not a trace: a row is replaced as its bot moves on and
   * gone when its turn ends, so it never enters the transcript the host keeps.
   * A room can have several bots working at once, which is why this is a list:
   * `key` is the turn's own identity, so a step changes the words inside the row
   * without rebuilding it — an opened step list and the label's animation last
   * until the bot starts another turn.
   */
  protected readonly acting = computed<ActingRow[]>(() => {
    const routing = this.routing();
    if (routing === null) {
      return [];
    }
    const id = this.morse.bot.activeId();
    const bots = this.morse.bot.roster()?.bots ?? [];
    return routing.active.map((entry, index) => {
      const activity = entry.activity;
      // The handle is the identity: a display name can repeat, and two rows that
      // both resolved to the first "Forge" would share one key, one ring and one
      // Stop. The roster only supplies the avatar, so a bot deleted mid-turn
      // still draws its name and letter.
      const bot = bots.find((one) => one.username === entry.username);
      const usage = id === null ? undefined : this.morse.bot.usageFor(id, entry.username);
      const ring = usage === undefined ? undefined : botUsageInputs(usage);
      const newest = entry.steps.at(-1) ?? activity;
      // The reader is shown the work, not the model's thinking: a thought keeps
      // the row's presence alive (its clock and its shimmer) but no list or
      // count names it, so the chevron only promises steps a reader can check.
      const shownSteps = visibleSteps(entry.steps);
      // The handle and the start time are the turn: steps arrive under the same
      // pair, and a new turn is the only thing that changes it.
      const turnKey = `${entry.username}:${entry.startedAt}`;
      return {
        key: turnKey,
        turnKey,
        kind: activity.kind,
        label: activity.label,
        name: entry.target,
        avatar: bot?.avatar ?? '',
        // The queue belongs to the room, not to one bot: it is drawn once, under
        // the first row, rather than repeated beside every working member.
        queued: index === 0 ? routing.queued : [],
        username: entry.username,
        startedAt: entry.startedAt,
        lastStepAt: newest.at,
        runningTool:
          entry.steps.some((step) => step.status === 'running') || activity.status === 'running',
        stepCount: shownSteps.length,
        // Three is what a glance can hold; the rest is the finished turn's record.
        steps: shownSteps.slice(-3),
        partial: entry.partial ?? '',
        handoffs: entry.handoffs,
        // A bot that has not reported yet has nothing to draw, so its row stays
        // ringless rather than showing an empty gauge.
        ...(ring === undefined || !hasBotUsage(ring) ? {} : { ring }),
      };
    });
  });

  /**
   * How much of each bot's live answer has been revealed, by handle.
   *
   * Keyed by the bot, not by the row: the words must not start over just because
   * the bot moved on to its next tool. The cursor itself remembers the turn, so
   * only a genuinely new turn resets it.
   */
  private readonly cursors = signal<Readonly<Record<string, RevealCursor>>>({});
  /** The wall clock the live rows read, so their timers move without a push. */
  private readonly now = signal(Date.now());
  /** The live rows the reader has opened the steps of, by turn. */
  protected readonly expandedSteps = signal<ReadonlySet<string>>(new Set<string>());
  private revealTimer: ReturnType<typeof setInterval> | undefined;
  private clockTimer: ReturnType<typeof setInterval> | undefined;

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
    // The live rows keep two clocks of their own: the reveal of an answer still
    // arriving, and the wall clock under the elapsed time and the quiet read. Both
    // follow the rows: nothing runs while no bot is working, and nothing survives
    // the row it was started for.
    effect(() => {
      const rows = this.acting();
      untracked(() => {
        this.now.set(Date.now());
        this.syncCursors(rows, false);
        this.syncRevealTimer(rows);
        this.syncClockTimer(rows.length > 0);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.stopRevealTimer();
      this.stopClockTimer();
    });
  }

  /** The part of a working bot's answer that is on screen, as plain text. */
  protected revealed(row: ActingRow): string {
    return this.cursors()[row.username]?.revealed ?? '';
  }

  /** How long the bot has been on this turn, once it is old enough to say. */
  protected elapsed(row: ActingRow): string | undefined {
    return elapsedLabel(this.now() - row.startedAt);
  }

  /** Whether the bot has stopped reporting steps, so the row stops shimmering. */
  protected quiet(row: ActingRow): boolean {
    return rowIsQuiet(this.now(), row.lastStepAt, row.runningTool);
  }

  /**
   * The row's one sentence for assistive tech: who is working and what it is
   * doing. The visible row carries the steps, the words and the chips, which a
   * screen reader would read out as noise every time a tool changed.
   */
  protected liveSentence(row: ActingRow): string {
    if (this.quiet(row)) {
      return `${row.name} is waiting on the model.`;
    }
    const doing = sentenceCase(row.label);
    return `${row.name} is ${doing.replace(/[.…!?]+$/, '')}.`;
  }

  /** Whether the reader has opened this live turn's step list. */
  protected stepsOpen(turnKey: string): boolean {
    return this.expandedSteps().has(turnKey);
  }

  /** What the chevron says: every step, or the newest three of a longer turn. */
  protected stepsLabel(row: ActingRow): string {
    if (row.stepCount <= row.steps.length) {
      return row.stepCount === 1 ? '1 step' : `${row.stepCount} steps`;
    }
    return `Latest ${row.steps.length} of ${row.stepCount} steps`;
  }

  /** Opens or closes one live turn's steps; other turns keep their own state. */
  protected toggleSteps(turnKey: string): void {
    this.expandedSteps.update((open) => {
      const next = new Set(open);
      if (!next.delete(turnKey)) {
        next.add(turnKey);
      }
      return next;
    });
  }

  /**
   * A handoff chip in words: `asked @loom`, `loom is working`, `loom answered`,
   * `loom failed`. The wire's state names are for machines; a reader gets the
   * sentence the row would say out loud.
   */
  protected handoffLabel(handoff: BotHandoff): string {
    switch (handoff.state) {
      case 'asked':
        return `asked @${handoff.username}`;
      case 'working':
        return `${handoff.username} is working`;
      case 'done':
        return `${handoff.username} answered`;
      case 'failed':
        return `${handoff.username} failed`;
    }
  }

  /**
   * Lines this bot's revealed words up with what the host has sent.
   *
   * The cursor belongs to a turn, not to a push. The host keeps only the tail of
   * a long answer, so every push past 2 000 characters drops its head; the
   * longest suffix of the on-screen text that is still the head of the new one
   * is how much both share. The words already shown therefore stay, and only the
   * text after that overlap is revealed. A different turn starts at nothing, so
   * an answer never borrows the previous one's place.
   */
  private syncCursors(rows: readonly ActingRow[], advance: boolean): void {
    const previous = this.cursors();
    const next: Record<string, RevealCursor> = {};
    for (const row of rows) {
      const held = previous[row.username];
      const sameTurn = held !== undefined && held.turnKey === row.turnKey;
      // How much of what is on screen is still the head of the text that arrived.
      const overlap = sameTurn ? overlapWithRevealed(held.revealed, row.partial) : 0;
      const shown = advance ? revealLength(overlap, row.partial) : overlap;
      next[row.username] = {
        turnKey: row.turnKey,
        shown,
        revealed: sameTurn
          ? held.revealed + row.partial.slice(overlap, shown)
          : row.partial.slice(0, shown),
      };
    }
    this.cursors.set(next);
  }

  /** Whether any working bot still has words the reader has not been shown. */
  private pendingWords(rows: readonly ActingRow[]): boolean {
    const cursors = this.cursors();
    return rows.some((row) => row.partial.length > (cursors[row.username]?.shown ?? 0));
  }

  private syncRevealTimer(rows: readonly ActingRow[]): void {
    if (!this.pendingWords(rows)) {
      this.stopRevealTimer();
      return;
    }
    if (this.revealTimer !== undefined) {
      return;
    }
    this.revealTimer = setInterval(() => {
      const current = this.acting();
      this.now.set(Date.now());
      this.syncCursors(current, true);
      if (!this.pendingWords(current)) {
        this.stopRevealTimer();
      }
    }, REVEAL_INTERVAL_MS);
  }

  private stopRevealTimer(): void {
    if (this.revealTimer !== undefined) {
      clearInterval(this.revealTimer);
      this.revealTimer = undefined;
    }
  }

  private syncClockTimer(running: boolean): void {
    if (!running) {
      this.stopClockTimer();
      return;
    }
    if (this.clockTimer !== undefined) {
      return;
    }
    this.clockTimer = setInterval(() => this.now.set(Date.now()), CLOCK_INTERVAL_MS);
  }

  private stopClockTimer(): void {
    if (this.clockTimer !== undefined) {
      clearInterval(this.clockTimer);
      this.clockTimer = undefined;
    }
  }

  /** The divider's wall-clock time, so a boundary is placeable in the day. */
  protected when(at: number): string {
    return new Date(at).toLocaleString();
  }

  protected stamp(at: number): string {
    return new Date(at).toISOString();
  }

  /** The clock under a line: when it was said, in the reader's locale. */
  protected clock(at: number): string {
    return clockTime(at);
  }

  /** The clock's tooltip: the full date, so an old line is still placeable. */
  protected fullStamp(at: number): string {
    return fullTime(at);
  }

  /**
   * A step's outcome in the reader's words. The wire's `ok` and `error` are for
   * machines; a finished turn has no outcome to report for a step still marked
   * running, so it says nothing there.
   */
  protected stepOutcome(status: BotActivity['status'], finished = false): string | undefined {
    switch (status) {
      case 'ok':
        return 'done';
      case 'error':
        return 'failed';
      case 'running':
        return finished ? undefined : 'running';
      default:
        return undefined;
    }
  }

  /** Whether the reader has opened the peer's message under this line. */
  protected isPeerOpen(entryId: string): boolean {
    return this.openPeers().has(entryId);
  }

  /** Opens or closes one peer's message; the others keep their own state. */
  protected togglePeer(entryId: string): void {
    this.openPeers.update((open) => {
      const next = new Set(open);
      if (!next.delete(entryId)) {
        next.add(entryId);
      }
      return next;
    });
  }

  /** The peer's answer this line was woken by, carried with the bot's own words. */
  protected peerReply(
    entry: BotTranscriptEntry,
  ): { entryId: string; reply: BotTurnReply } | undefined {
    const reply = entry.reply;
    return reply === undefined ? undefined : { entryId: entry.id, reply };
  }

  /** Follows a handoff to the conversation the ask happened in. */
  protected openHandoff(handoff: BotHandoff): void {
    this.morse.openBotConversation(handoff.conversationId);
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

  /** The thumbnail opened full-size, with the same overlay code mode shows. */
  protected readonly shownImage = signal<{ src: string; label: string } | null>(null);

  protected openImage(image: PromptImage, index: number): void {
    this.shownImage.set({ src: this.preview(image), label: `Image ${index + 1}` });
  }

  protected closeImage(): void {
    this.shownImage.set(null);
  }

  protected onEscape(): void {
    this.closeImage();
  }

  /**
   * Shrinks what the bots remember of this conversation. Their engines summarise
   * their own context; the lines here stay, so this never needs a warning.
   */
  protected compact(): void {
    this.morse.compactBotConversation();
  }

  /**
   * Empties the conversation for good — its lines, its file, and every member's
   * engine session — so it asks first. Nothing here can be undone, unlike a new
   * discussion, which keeps the history.
   */
  protected clearMessages(): void {
    const id = this.morse.bot.activeId();
    if (id === null) {
      return;
    }
    const confirmed = confirm(
      'Clear every message in this conversation? Its transcript and the bots\u2019 engine sessions are deleted. This cannot be undone.',
    );
    if (!confirmed) {
      return;
    }
    this.morse.clearBotMessages(id);
  }

  /**
   * A presence row's own Stop: it halts that bot's turn and its queued work in the
   * conversation in front, leaving a teammate running. It always names a handle:
   * the host routes on handles, and a display name may belong to two bots.
   */
  protected stop(username: string): void {
    this.morse.stopBotRound(this.morse.bot.activeId(), username);
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
