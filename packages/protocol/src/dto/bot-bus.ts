/**
 * Bot mode's delivery bus: one queued unit of work that names a bot and one
 * transcript line, the roster a bot reads to find a teammate, the call a bot
 * makes to hand work over, and the record a settled turn leaves behind.
 *
 * A delivery exists so that "ask this bot about that line" is data the host can
 * persist, queue and retry rather than a call held open inside a turn. These are
 * the shapes the host's bus and the plugins' tools both speak, so a later
 * implementation cannot rename a field one side already promises.
 */

/**
 * What a bus call is for. `message` is ordinary conversation, `assign` marks work
 * the sender wants done, and `reply` marks an answer to an earlier assignment —
 * the distinction travels with the delivery so the recipient can read the intent
 * without guessing it from the wording.
 */
export type BotDeliveryKind = 'message' | 'assign' | 'reply';

/**
 * Why this bot was asked. Only `lead` carries the routing brief — the case where
 * nobody was addressed and this bot must answer or delegate — so the reason has
 * to be recorded, not inferred from an empty mention list.
 */
export type BotDeliveryReason = 'mention' | 'all' | 'lead' | 'direct' | 'bot' | 'trigger';

/**
 * How far a delivery has moved. A status only moves forward; `dropped` is the
 * host's verdict (queue overflow or the undelivered TTL) and `failed` is the
 * engine's, so a reader can tell a refusal from a crash.
 */
export type BotDeliveryStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'cancelled';

/**
 * Who caused a delivery: the reader, another bot, or Morse itself on behalf of a
 * webhook, a schedule or an API call. A bot's own sends arrive as `bot`, never as
 * the person — that is what keeps one bot's text from reading as approval.
 */
export type BotDeliveryOrigin =
  | { type: 'person'; id: string; name: string; username?: string }
  | { type: 'bot'; username: string }
  | { type: 'system'; source: 'webhook' | 'schedule' | 'api' };

/**
 * One queued ask, persisted per conversation so it survives a restart.
 *
 * `rootId` is the trigger every delivery caused by it shares, which is what makes
 * a "this work is finished" view possible. `entryId` is always
 * present: a delivery asks about a transcript line, written before the delivery is
 * queued, so a turn's context is a slice that ends at a known line instead of a
 * loose message string.
 */
export interface BotDelivery {
  id: string;
  /**
   * The id of the trigger this delivery descends from, shared by every delivery
   * that trigger caused. A person's message mints one root id for the deliveries
   * it fans out, so a depth-0 delivery carries that shared id rather than one
   * equal to its own `id` — the root is the trigger, not any one ask.
   */
  rootId: string;
  conversationId: string;
  /** The transcript line this delivery asks about. Always present. */
  entryId: string;
  from: BotDeliveryOrigin;
  /** The recipient's username: the only key a lane and a client index use. */
  to: string;
  /**
   * The room the sender was working in when it asked. The sender is woken there
   * with the peer's answer, and it is the sender that answers the person.
   *
   * Recorded per ask rather than per thread because a private thread is one
   * long-lived room per pair of bots: every ask between them reuses it, from
   * whichever room the sender happened to be answering in. Absent on deliveries
   * written before this was recorded, and on the wake-up delivery the relay
   * sends back — an answer has no ask of its own.
   */
  originId?: string;
  /**
   * The peer's words a wake-up carries, for the bot that asked to say in its own
   * voice.
   *
   * A peer's answer is never a transcript line in the room the ask came from:
   * the person messaged their bot, and a delegated bot appearing there — even
   * quoted — would read as a second person in the room. So the relay hands the
   * words to the asker's prompt instead, and the asker answers the person with
   * them. An empty string is a real value: the peer's turn ended without words,
   * and the person is still waiting to be told. Absent on every delivery that is
   * not a relay's wake-up.
   */
  answer?: string;
  kind: BotDeliveryKind;
  reason: BotDeliveryReason;
  /** Bot-to-bot hops from the root — a count for the record; nothing refuses on it. */
  depth: number;
  createdAt: number;
  status: BotDeliveryStatus;
  /** Why a delivery was dropped or failed, worded for the transcript's system line. */
  note?: string;
}

/**
 * The peer's answer a turn was woken by.
 *
 * Kept on the bot's own line rather than written into the room: the person
 * messaged their own bot, so the peer never speaks there. A reader can open it
 * under the line that says the bot messaged that peer, where the answer came
 * from, and the words are shown only when asked for.
 */
export interface BotTurnReply {
  /** The bot that answered, by handle. */
  username: string;
  /** Its display name at settle time: handles are reusable, this keeps its own. */
  name: string;
  /** Epoch milliseconds the answer was handed back. */
  at: number;
  /** What it said; empty when its turn ended without words. */
  text: string;
}

/**
 * One bot as `bot_list` reports it: what another bot needs to decide whether to
 * delegate, and nothing it should not see — no credentials, workspace, model or
 * conversations.
 */
export interface BotRosterEntry {
  username: string;
  name: string;
  /**
   * The capability signal, truncated to `BOT_DESCRIPTION_LIMIT`: the roster is
   * fetched whole, so one long description must not make the list unaffordable.
   */
  description: string;
  state: 'idle' | 'working' | 'queued';
  /** Deliveries waiting behind the current turn, so a sender can see the backlog. */
  queued: number;
  /** True when the caller and this bot share the conversation being answered. */
  inRoom: boolean;
}

/**
 * What `bot_send` sends. `to` is one username and `kind` defaults to `message`.
 * There are no files here on purpose: a path means one bot's own workspace, and
 * copying bytes between two workspaces is a decision this contract does not make.
 */
export interface BotBusSendInput {
  to: string;
  text: string;
  kind?: BotDeliveryKind;
}

/**
 * What `bot_send` answers: the delivery it queued and where it landed, so the
 * caller can name the work in its own reply without a second lookup.
 */
export interface BotBusSendResult {
  deliveryId: string;
  conversationId: string;
  queued: boolean;
}

/**
 * One human as `human_list` reports them: what a bot needs to address a
 * person, and nothing else — never an email, a role or a credential.
 */
export interface BotHumanRosterEntry {
  /** The stable login id `human_send` addresses. */
  id: string;
  /** The login username, shown as `@username` where a bot reads it. */
  username: string;
  /** Display name. Falls back to the username when the host has none. */
  name: string;
}

/**
 * What `human_send` sends. `to` is a login id or username, resolved in that
 * order. Without `conversationId` the line lands in that human's DM with the
 * sending bot (created on first send); with one it must name a room that human
 * owns and the bot is a member of.
 */
export interface BotBusHumanSendInput {
  to: string;
  text: string;
  conversationId?: string;
}

/**
 * The most description characters the roster returns per bot. A roster is read
 * whole on every `bot_list` call, so the cap is what keeps a large roster cheap.
 */
export const BOT_DESCRIPTION_LIMIT = 300 as const;
