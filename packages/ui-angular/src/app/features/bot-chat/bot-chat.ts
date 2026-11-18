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
  BotHandoff,
  BotTranscriptEntry,
  BotTurnTrace,
  BotUsage,
  PromptImage,
} from '@morse/protocol';
import { clockTime, fullTime } from '@morse/ui-runtime';
import { MorseService } from '../../host/morse.service';
import { ComposerDrafts } from '../../state/composer-drafts';
import { CopyButton } from '../../ui/copy-button/copy-button';
import { Markdown } from '../../ui/markdown/markdown';
import { ChatComposer, type BotComposerSend } from '../composer/composer';
import { botUsageInputs, hasBotUsage, type BotUsageInputs } from '../composer/bot-usage';
import type { MentionCandidate } from '../mention-picker/mention-picker';
import { UsageIndicator } from '../usage/usage-indicator';

/**
 * One row of the chat's timeline: a line the host kept, or the record of a turn
 * that produced one. Exactly one of `entry` and `trace` is set.
 */
interface TimelineItem {
  /** Unique across both kinds: an entry and a trace may share an id, never a row. */
  key: string;
  /** When it belongs in the conversation: a line's `at`, a trace's `endedAt`. */
  at: number;
  entry?: BotTranscriptEntry;
  trace?: BotTurnTrace;
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
  imports: [Markdown, ChatComposer, CopyButton, UsageIndicator],
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
  /**
   * One timeline of lines and finished turns, ordered by when each belongs in the
   * conversation.
   *
   * A turn is anchored to the answer it produced, not to the moment the host
   * stamped the trace: the answer is appended when the engine finishes and the
   * trace is written after it, with I/O in between, so `endedAt` usually follows
   * the answer's `at`. The anchor is the earliest bot line by that turn's own
   * handle falling between `startedAt` and `endedAt`; the record is placed right
   * before it. A turn with no such line — cancelled or failed before writing, or
   * its answer outside the loaded window — keeps its place by `endedAt`.
   */
  protected readonly timeline = computed<TimelineItem[]>(() => {
    const id = this.morse.bot.activeId();
    if (id === null) {
      return [];
    }
    const entries = this.morse.bot.transcripts()[id] ?? [];
    const anchored = new Map<string, BotTurnTrace[]>();
    const loose: TimelineItem[] = [];
    for (const trace of this.morse.bot.tracesFor(id)) {
      const answer = answerFor(trace, entries);
      if (answer === undefined) {
        loose.push({ key: `trace:${trace.id}`, at: trace.endedAt, trace });
        continue;
      }
      const held = anchored.get(answer.id) ?? [];
      held.push(trace);
      anchored.set(answer.id, held);
    }
    const items: TimelineItem[] = [
      ...loose,
      ...entries.map((entry) => ({ key: `entry:${entry.id}`, at: entry.at, entry })),
    ];
    items.sort((left, right) => left.at - right.at || itemRank(left) - itemRank(right));
    const ordered: TimelineItem[] = [];
    for (const item of items) {
      const { entry } = item;
      if (entry !== undefined) {
        for (const trace of anchored.get(entry.id) ?? []) {
          ordered.push({ key: `trace:${trace.id}`, at: entry.at, trace });
        }
      }
      ordered.push(item);
    }
    return ordered;
  });
  /** Whether the host said older entries exist before the ones held. */
  protected readonly hasOlder = computed(() => {
    const id = this.morse.bot.activeId();
    return id === null ? false : this.morse.bot.hasOlder()[id] === true;
  });
  /** True while a page of older entries is in flight, so the row says so. */
  protected readonly loadingOlder = signal(false);
  /** The finished turns the reader has opened; a closed one is one line. */
  protected readonly expandedTurns = signal<ReadonlySet<string>>(new Set<string>());

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
   * One line of presence per bot working right now — "Reading launch-brief.md" —
   * where its answer will appear.
   *
   * A chat has presence, not a trace: a row is replaced as its bot moves on and
   * gone when its turn ends, so it never enters the transcript the host keeps.
   * A room can have several bots working at once, which is why this is a list:
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
      /** The bot's handle: unique, and the only thing a stop takes. */
      username: string;
      /** This bot's own counters, so its row's ring describes its own window. */
      ring?: BotUsageInputs;
    }[]
  >(() => {
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
      return {
        key: `${entry.username}:${activity.kind}:${activity.at}`,
        kind: activity.kind,
        label: activity.label,
        name: entry.target,
        mark: bot?.avatar ?? entry.target.slice(0, 1).toUpperCase(),
        // The queue belongs to the room, not to one bot: it is drawn once, under
        // the first row, rather than repeated beside every working member.
        queued: index === 0 ? routing.queued : [],
        username: entry.username,
        // A bot that has not reported yet has nothing to draw, so its row stays
        // ringless rather than showing an empty gauge.
        ...(ring === undefined || !hasBotUsage(ring) ? {} : { ring }),
      };
    });
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

  /** The clock under a line: when it was said, in the reader's locale. */
  protected clock(at: number): string {
    return clockTime(at);
  }

  /** The clock's tooltip: the full date, so an old line is still placeable. */
  protected fullStamp(at: number): string {
    return fullTime(at);
  }

  /** A bot's mark: its own avatar when it has one, else the letter it starts with. */
  protected mark(author: BotAuthor & { role: 'bot' }): string {
    return author.avatar ?? author.name.slice(0, 1).toUpperCase();
  }

  /** A finished turn's mark, from the name it was written with. */
  protected initial(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  /**
   * The one line a finished turn collapses to: whose turn it was, how long it
   * ran, how many steps it took, and whom it asked.
   *
   * The name comes from the trace, not the roster: a handle can be reused and a
   * bot renamed or deleted, and the record still has to say who did the work.
   */
  protected turnSummary(trace: BotTurnTrace): string {
    const steps = trace.steps.length === 1 ? '1 step' : `${trace.steps.length} steps`;
    const parts = [trace.name, turnDuration(trace.endedAt - trace.startedAt), steps];
    if (trace.handoffs.length > 0) {
      parts.push(`asked ${trace.handoffs.map((handoff) => `@${handoff.username}`).join(', ')}`);
    }
    return parts.join(' · ');
  }

  /** Whether the reader has opened this turn's step list. */
  protected isExpanded(id: string): boolean {
    return this.expandedTurns().has(id);
  }

  /** Opens or closes one turn's record; the others keep their own state. */
  protected toggleTurn(id: string): void {
    this.expandedTurns.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
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

/**
 * The line a finished turn wrote, when the loaded window still holds it.
 *
 * The handle is the identity: a display name may repeat, and an older line may
 * carry no handle at all. The earliest bot line by that handle inside the turn's
 * own span is the answer — a later line from the same bot belongs to a later turn.
 */
function answerFor(
  trace: BotTurnTrace,
  entries: BotTranscriptEntry[],
): BotTranscriptEntry | undefined {
  let answer: BotTranscriptEntry | undefined;
  for (const entry of entries) {
    if (entry.author.role !== 'bot' || entry.author.username !== trace.username) {
      continue;
    }
    if (entry.at < trace.startedAt || entry.at > trace.endedAt) {
      continue;
    }
    if (answer === undefined || entry.at < answer.at) {
      answer = entry;
    }
  }
  return answer;
}

/** A trace sorts before an entry at the same instant, so a record sits above its line. */
function itemRank(item: TimelineItem): number {
  return item.trace === undefined ? 1 : 0;
}

/**
 * How long a finished turn ran, in the reader's words.
 *
 * Rounded to whole seconds, so a short turn says `0s` rather than a decimal that
 * claims more precision than a person reads. A finished turn always shows its
 * duration: unlike the live row, there is no threshold below which it is noise —
 * the record is the point.
 */
function turnDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
