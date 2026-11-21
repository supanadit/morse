/**
 * Bot mode's pure helpers: ids, transcript wording, interaction defaults and the
 * small predicates the service and its stores share.
 */
import { randomBytes } from 'node:crypto';
import type {
  AgentFormRequest,
  AgentFormValue,
  AgentInteractionRequest,
  AgentInteractionResponse,
} from '@morse/agent';
import { BOT_DESCRIPTION_LIMIT } from '@morse/protocol';
import type { BotAuthor, BotDeliveryStatus, BotHandoff, BotTurnTrace } from '@morse/protocol';
import type { BotRecord } from './types.js';

/**
 * What the plugin reads from a bot's turn file: the room, trigger and hop count
 * the bot is answering in, without the bot having to name any of them. `expiresAt`
 * is the turn's own deadline, so a file a crash left behind stops being a turn.
 */
export interface BusTurnContext {
  deliveryId: string;
  conversationId: string;
  rootId: string;
  depth: number;
  expiresAt: number;
}

/**
 * One bot's counters in one room, keyed by the room as well as the bot: one bot
 * may be warm in several conversations, and each ring describes one of them.
 */
export function usageKey(conversationId: string, username: string): string {
  return `${conversationId}\u0000${username}`;
}

/**
 * One delivery's own status as the handoff that created it reads it: a waiting
 * ask is still `asked`, a running turn is `working`, and every terminal end that
 * is not an answer — a failure, a drop, a cancel — is `failed`.
 */
export function handoffState(status: BotDeliveryStatus): BotHandoff['state'] {
  switch (status) {
    case 'queued':
      return 'asked';
    case 'running':
      return 'working';
    case 'done':
      return 'done';
    case 'failed':
    case 'dropped':
    case 'cancelled':
      return 'failed';
  }
}

/**
 * How a settled delivery reads as history. A turn only ever ends done, failed or
 * cancelled; the other delivery states belong to asks that never settled as a
 * turn at all.
 */
export function traceStatus(status: BotDeliveryStatus): BotTurnTrace['status'] {
  return status === 'done' || status === 'failed' ? status : 'cancelled';
}

/**
 * One delivery or root id. Hex, so it is path-safe everywhere an id can end up
 * and short enough to read in a transcript note; random, so two hosts that were
 * never introduced cannot mint the same one.
 */
export function newDeliveryId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The one conversation id a pair of bots shares, whichever of them is sending:
 * the usernames sorted, so `bot_send` finds the same thread from either side.
 */
export function threadConversationId(left: string, right: string): string {
  return left < right ? `thread-${left}-${right}` : `thread-${right}-${left}`;
}

/** The roster's description, cut to the cap a whole-list fetch can afford. */
export function cappedDescription(description: string): string {
  return description.length <= BOT_DESCRIPTION_LIMIT
    ? description
    : description.slice(0, BOT_DESCRIPTION_LIMIT);
}

/** Whether a parsed turn file is the shape the plugin and the host agreed on. */
export function isBusTurnContext(value: unknown): value is BusTurnContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const turn = value as Record<string, unknown>;
  return (
    typeof turn['deliveryId'] === 'string' &&
    typeof turn['conversationId'] === 'string' &&
    typeof turn['rootId'] === 'string' &&
    typeof turn['depth'] === 'number' &&
    typeof turn['expiresAt'] === 'number'
  );
}

/** The transcript line a relay arrives as: who, in which conversation, said what. */
export function relayLine(title: string, author: string, text: string): string {
  return `[${title}] ${author}: ${text}`;
}

/**
 * What was attached, said in one clause for the bots that only get the relay
 * text: an engine handed real images sees them itself, but a teammate reading a
 * relay must be told the picture was there.
 */
export function attachmentSummary(images: number, files: number): string {
  const parts: string[] = [];
  if (images > 0) {
    parts.push(`${images} image${images === 1 ? '' : 's'}`);
  }
  if (files > 0) {
    parts.push(`${files} file${files === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? '' : `[attached: ${parts.join(', ')}]`;
}

/** The brief an unaddressed group message prefixes onto its lead's prompt. */
export function leadBrief(title: string): string {
  return `You are the lead of the group "${title}". Answer, or ask a member with bot_send.`;
}

/** The default answer to one engine question. */
export function autoAnswerFor(request: AgentInteractionRequest): AgentInteractionResponse {
  switch (request.kind) {
    case 'confirm':
      return { requestId: request.requestId, confirmed: true };
    case 'select':
      return { requestId: request.requestId, value: request.options[0]?.value ?? '' };
    case 'input':
      return { requestId: request.requestId, value: request.value ?? '' };
    case 'editor':
      // The engine's own draft is the answer. A bot has no reader to type one,
      // and cancelling loses the whole tool call — a web search opened as an
      // editor prompt never runs when the prompt is dismissed instead.
      return { requestId: request.requestId, value: request.value ?? '' };
    case 'form':
      return { requestId: request.requestId, values: formDefaults(request) };
  }
}

/**
 * A form's answer, filled the way a silent reader would: the seed a field
 * carries, the first choice a list offers, and the empty value its type implies.
 * Nothing is invented beyond that — a bot cannot reason about a form it cannot
 * see, so the safest complete answer is its own defaults.
 */
export function formDefaults(request: AgentFormRequest): Record<string, AgentFormValue> {
  const values: Record<string, AgentFormValue> = {};
  for (const field of request.fields) {
    if (field.defaultValue !== undefined) {
      values[field.key] = field.defaultValue;
      continue;
    }
    switch (field.type) {
      case 'boolean':
        values[field.key] = false;
        break;
      case 'number':
      case 'integer':
        values[field.key] = 0;
        break;
      case 'multiselect':
        values[field.key] = [];
        break;
      case 'select': {
        const first = field.options?.[0]?.value;
        if (first !== undefined) {
          values[field.key] = first;
        }
        break;
      }
      default:
        values[field.key] = '';
    }
  }
  return values;
}

/** How the transcript describes an auto-answer, stable per request kind. */
export function autoAnswerSummary(request: AgentInteractionRequest): string {
  switch (request.kind) {
    case 'confirm':
      return `confirmed "${request.title}"`;
    case 'select':
      return `selected the first option of "${request.title}"`;
    case 'input':
    case 'editor':
      return request.value === undefined || request.value.length === 0
        ? `left "${request.title}" blank`
        : `filled "${request.title}" from its draft`;
    case 'form':
      return `filled "${request.title}" with its defaults`;
  }
}

export function botAuthor(bot: BotRecord): BotAuthor {
  return {
    role: 'bot',
    name: bot.name,
    username: bot.username,
    ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
  };
}

/**
 * A username that stays inside `<root>/<username>/` and parses as a `@handle`:
 * lowercase letters, digits, dashes and underscores, starting with a letter or
 * digit, at most 32 characters. Keeping it lowercase is what makes a mention
 * unambiguous, and keeping it slash-free is what keeps it a directory name that
 * cannot escape the data dir.
 */
export function isSafeUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(username);
}

/** A subagent name that is usable as a config key in either engine's own file. */
export function isSafeSubagentName(name: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(name);
}

export function warmKey(conversationId: string, username: string): string {
  return `${conversationId}\u0000${username}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
