import type { BotDeliveryReason } from '@morse/protocol';
import { parseMentions } from './mentions.js';

/**
 * The decisions a per-bot lane makes before it takes work: whom a person's
 * message reaches and whom a bot's reply asks.
 *
 * Both are pure. The lane owns the queue, the store and the turn; keeping the
 * decisions here means routing can be tested — and reasoned about — without an
 * engine running or a file on disk.
 */

/**
 * How many asks one bot may have waiting. It is a bound on memory, not on a
 * conversation: a full queue drops its oldest ask with a note and still takes
 * the newcomer, so a noisy sender cannot bury a bot's own work in a backlog
 * nobody reads. Bots talk as long as they like; a person stops them.
 */
export const BUS_LIMITS = {
  queuePerBot: 32,
} as const;

/**
 * A conversation's shape. Only a DM carries direct semantics — its one bot is
 * reached without an address — while a group and a private bot-to-bot thread
 * both route by mention, then lead, then everyone.
 */
export type BotConversationKind = 'dm' | 'group' | 'thread';

/** One bot a message reaches, and why it was chosen. */
export interface BotAddress {
  username: string;
  reason: BotDeliveryReason;
}

/** What the router knows about a person's message when it picks recipients. */
export interface BotAddressInput {
  /** The message text, parsed for handles only. */
  text: string;
  /** The conversation's bots, in roster order. */
  members: string[];
  /** The group's lead, when it has one. Ignored when it is not a member. */
  lead?: string;
  kind: BotConversationKind;
}

/**
 * Whom a person's message addresses, in the order they should answer.
 *
 * A named handle is the most specific thing a sender can say, so mentions win
 * over a broadcast word in the same message; the broadcast is still reported by
 * `parseMentions` for the router to note. An unaddressed DM goes to its bot
 * because there is nobody else, an unaddressed group goes to its lead, and a
 * group with no lead goes to everyone rather than to nobody — silence would look
 * like a broken bot.
 *
 * A lead that is not on the member list is not addressed: it is either stale or
 * wrong, and returning it would queue work for a bot that left the room. The
 * message falls through to the same "everyone" case instead.
 */
export function addressedBots({ text, members, lead, kind }: BotAddressInput): BotAddress[] {
  const { targets, all } = parseMentions(text, members);
  if (targets.length > 0) {
    return targets.map((username) => ({ username, reason: 'mention' }));
  }
  if (all) {
    return members.map((username) => ({ username, reason: 'all' }));
  }
  if (kind === 'dm') {
    return members.map((username) => ({ username, reason: 'direct' }));
  }
  // The lead is compared case-insensitively, like a mention, but answered with
  // the stored spelling so every downstream key stays the member's own.
  const member =
    lead === undefined
      ? undefined
      : members.find((name) => name.toLowerCase() === lead.toLowerCase());
  if (member !== undefined) {
    return [{ username: member, reason: 'lead' }];
  }
  return members.map((username) => ({ username, reason: 'all' }));
}

/** What a lane knows about one bot's reply when it decides whom the reply asks. */
export interface BotReplyInput {
  /** The reply text, parsed for handles only. */
  text: string;
  /** The room's bots, in roster order. */
  members: string[];
  /** The bot that wrote the reply. */
  self: string;
}

/**
 * Whom a bot's reply asks: the members it names by handle, the way a person's
 * message does — so a group reads as one line from the asker and then the
 * teammate's answer, never a second line saying the ask was sent.
 *
 * Naming the bot that asked is a new ask: two bots go back and forth by naming
 * each other, and each ends the exchange by replying without a name — that is
 * how a bot says it is done. `@all` is left to people — a bot must name whom it
 * is talking to — and a bot never routes to itself.
 */
export function replyAddressedBots({ text, members, self }: BotReplyInput): BotAddress[] {
  const { targets } = parseMentions(text, members);
  return targets
    .filter((username) => username !== self)
    .map((username) => ({ username, reason: 'mention' }));
}
