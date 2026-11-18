/**
 * Bot mode's delivery bus: one queued unit of work that names a bot and one
 * transcript line, the roster a bot reads to find a teammate, and the call a
 * bot makes to hand work over.
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
 * backstop's verdict (queue overflow, depth cap, a restart that cannot resume)
 * and `failed` is the engine's, so a reader can tell a refusal from a crash.
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
  | { type: 'person'; id: string; name: string }
  | { type: 'bot'; username: string }
  | { type: 'system'; source: 'webhook' | 'schedule' | 'api' };

/**
 * One queued ask, persisted per conversation so it survives a restart.
 *
 * `rootId` is the trigger every delivery caused by it shares, which is what makes
 * a depth cap and a "this work is finished" view possible. `entryId` is always
 * present: a delivery asks about a transcript line, written before the delivery is
 * queued, so a turn's context is a slice that ends at a known line instead of a
 * loose message string.
 */
export interface BotDelivery {
  id: string;
  /** The original trigger this delivery descends from; equal to `id` at depth 0. */
  rootId: string;
  conversationId: string;
  /** The transcript line this delivery asks about. Always present. */
  entryId: string;
  from: BotDeliveryOrigin;
  /** The recipient's username: the only key a lane and a client index use. */
  to: string;
  kind: BotDeliveryKind;
  reason: BotDeliveryReason;
  /** Bot-to-bot hops from the root; the host refuses past its cap. */
  depth: number;
  createdAt: number;
  status: BotDeliveryStatus;
  /** Why a delivery was dropped or failed, worded for the transcript's system line. */
  note?: string;
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
 * The most description characters the roster returns per bot. A roster is read
 * whole on every `bot_list` call, so the cap is what keeps a large roster cheap.
 */
export const BOT_DESCRIPTION_LIMIT = 300 as const;
