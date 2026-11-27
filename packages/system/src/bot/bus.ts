import type { BotDeliveryReason } from '@morse/protocol';
import { parseMentions } from './mentions.js';

/**
 * The decisions a per-bot lane makes before it takes work: whom a person's
 * message reaches, whom a bot's reply asks, and whether a delivery must be
 * refused instead of queued.
 *
 * All are pure. The lane owns the queue, the store and the turn; keeping the
 * decisions here means routing and backstops can be tested — and reasoned about —
 * without an engine running or a file on disk.
 */

/**
 * What one delivery may spend. The depth and root caps bound a relay that a bot
 * starts; the queue and hourly caps bound what one bot handles, so a noisy
 * sender cannot bury a bot's own work in a backlog nobody reads.
 *
 * The queue cap is what a bot absorbs; the hourly cap is what a bot hands out —
 * it counts the sender's sends, not the recipient's receipts. All of them are per
 * delivery and per bot, not per conversation: a bot's attention and its token
 * budget are the scarce resources, wherever the asks come from.
 */
export const BUS_LIMITS = {
  depth: 4,
  perRoot: 48,
  queuePerBot: 32,
  perBotPerHour: 60,
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
  /** The bot whose ask this reply answers, when it is answering one. */
  asker?: string;
}

/**
 * Whom a bot's reply asks: the members it names by handle, the way a person's
 * message does — so a group reads as one line from the asker and then the
 * teammate's answer, never a second line saying the ask was sent.
 *
 * The asker is left out on purpose: a reply that names the bot that asked is an
 * answer to it, not a new ask, and routing it would ping-pong the two until the
 * depth cap. `@all` is left to people — a bot must name whom it is talking to —
 * and a bot never routes to itself.
 */
export function replyAddressedBots({ text, members, self, asker }: BotReplyInput): BotAddress[] {
  const { targets } = parseMentions(text, members);
  return targets
    .filter((username) => username !== self && username !== asker)
    .map((username) => ({ username, reason: 'mention' }));
}

/**
 * What a lane knows about one delivery when it decides whether to refuse it.
 *
 * There is no queue length here on purpose. A full queue does not reject the
 * newcomer — the lane drops the oldest queued delivery and notes it — so a count
 * this function cannot act on would only invite the wrong rule.
 */
export interface BusBackstopInput {
  /** Bot-to-bot hops from the trigger; a person's message is depth 0. */
  depth: number;
  /** Deliveries already caused by the same trigger. */
  rootCount: number;
  /** Deliveries the sender has handed out in the last hour. */
  recentCount: number;
}

/**
 * Whether a delivery must stop, as the sentence a person reads, or `undefined`
 * when the lane may queue it.
 *
 * The arms differ in what the caller does with the answer, because the spec's
 * limits differ in their effect:
 *
 * - `depth` past the cap and too many deliveries from one root are dropped: the
 *   caller does not queue the delivery and writes the sentence as the transcript
 *   note, so a reader can tell a loop from a bot that stopped talking.
 * - The hourly cap is a refusal: a bot is still holding its turn when it hits it,
 *   so the sentence is returned as a tool error and the sender learns to stop and
 *   say why. It counts what the sender has sent, not what the recipient received:
 *   the cap is on one bot's chatter, so a popular bot is not punished for being
 *   asked a lot.
 *
 * The queue cap is deliberately absent: it is the lane's, which owns the queue and
 * can drop the oldest queued row with a note. Refusing the newcomer here would be
 * the opposite of that effect.
 *
 * The sentence names the limit it hit because an ask that only says "busy" leaves
 * the sender guessing whether to retry, wait or split the work. Each cap is
 * checked against "more than", so a delivery at the limit is still taken: the
 * limit is what a bot may absorb, not one less.
 */
export function busRefusal({
  depth,
  rootCount,
  recentCount,
}: BusBackstopInput): string | undefined {
  if (depth > BUS_LIMITS.depth) {
    return `This ask is ${depth} hops from its trigger, past the depth limit of ${BUS_LIMITS.depth}, so it was not queued.`;
  }
  if (rootCount > BUS_LIMITS.perRoot) {
    return `This trigger has already caused ${rootCount} deliveries, past its limit of ${BUS_LIMITS.perRoot}, so this one was not queued.`;
  }
  if (recentCount > BUS_LIMITS.perBotPerHour) {
    return `This bot has sent ${recentCount} deliveries in the last hour, past its limit of ${BUS_LIMITS.perBotPerHour}, so it was refused.`;
  }
  return undefined;
}
