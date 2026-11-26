/**
 * Bot mode: the roster of isolated bots, their conversations and the lines they
 * exchange. A bot is an agent with its own config, engine and model, so these
 * shapes name those choices per bot instead of borrowing a session's view state.
 */
import type { BotTurnReply } from './bot-bus.js';
import type { ModelOption } from './model.js';
import type { McpServer } from './mcp.js';
import type { ModelInput, ThinkingLevel } from './primitives.js';
import type { ContextUsage, SessionCounts, SessionSpeed, TokenUsage } from './session.js';
import type { PromptImage } from './transcript.js';

/** One bot in the roster, as the sidebar lists it. */
export interface BotSummary {
  /**
   * The bot's handle: unique under `<dataDir>/bot/<username>/`, its `@mention`,
   * and the key every conversation stores. Lowercase letters, digits, dashes and
   * underscores, so it is always usable as a directory and a handle.
   */
  username: string;
  /** What the reader calls it: free text, spaces and emoji included. */
  name: string;
  description: string;
  avatar?: string;
  /** The stable engine kind (`pi`, `opencode`). */
  engineKind: string;
  model?: ModelOption;
  thinkingLevel?: ThinkingLevel;
  /** True while the bot's engine is running, so the roster can show presence. */
  warm: boolean;
}

/**
 * One conversation in the roster: a DM with a bot, a group of bots, or the
 * private thread two bots opened to work something out between themselves.
 */
export interface BotConversationSummary {
  id: string;
  kind: 'dm' | 'group' | 'thread';
  title: string;
  /** Member bot usernames; an unaddressed group fan-out asks them in this order. */
  members: string[];
  /** The bot that answers when nothing is addressed, by username. */
  lead?: string;
  /**
   * Legacy, and no longer a setting: lanes have no chain, so a bot's reply queues
   * nothing by itself. Nothing reads it — the group dialog stopped at protocol 41
   * — and a host reports a constant for it. It stays on the summary until a later
   * cleanup takes it off the wire with every fixture that still names it.
   */
  chainCap: number;
  updatedAt: number;
  /** True while the host is summarising every member's engine context. */
  compacting?: boolean;
}

/**
 * Who said one transcript line: the reader, a named bot, Morse itself, or the
 * boundary of a discussion.
 *
 * A bot conversation is one endless chat across many engine sessions, so "new
 * discussion" is a line in it — `discussion` — rather than a reset. It is what
 * lets a reader scroll back through every session they ever had with a bot.
 */
export type BotAuthor =
  | {
      role: 'user';
      /**
       * Who asked, when the host knows. Absent on every line written before the bus
       * existed, and read as the host person — which is why it is optional rather
       * than a migration of the stored transcripts.
       */
      personId?: string;
      /** The login username, so a bot knows which human is speaking. */
      username?: string;
      /** The person's display name, so a room can show who spoke. */
      name?: string;
    }
  | { role: 'bot'; name: string; username?: string; avatar?: string }
  | { role: 'system' }
  | { role: 'discussion' };

/**
 * One file the reader attached to a line. A bot has no upload channel of its own,
 * so the bytes travel with the send and the host writes them into the bot's own
 * workspace: the bot then opens the path with its ordinary tools, exactly as it
 * would open any other file there.
 */
export interface BotFileInput {
  /** The file's own name; the host keeps it, made safe for a path. */
  name: string;
  mimeType: string;
  /** Base64, without a `data:` prefix. */
  data: string;
}

/**
 * One line of a bot conversation. Tool activity stays out of the transcript; a
 * routing notice or a chain-cap note is a `system` line, not chat.
 */
export interface BotTranscriptEntry {
  id: string;
  author: BotAuthor;
  text: string;
  at: number;
  /** Images the reader sent with this line, kept so the bubble can show them. */
  images?: PromptImage[];
  /** Names of the files sent with this line, as the reader attached them. */
  files?: string[];
  /** The peer's answer that woke this bot, folded under its own line. */
  reply?: BotTurnReply;
}

/**
 * What a bot is doing this moment, in the reader's words.
 *
 * A chat shows presence, not a trace: the line is replaced by whatever the bot
 * moves on to and disappears with the answer, so nothing here is appended to the
 * transcript. The same shape is what a finished turn keeps, which is why a tool's
 * outcome rides along instead of ending at the engine's own event.
 *
 * The host is the one that knows what an engine's events mean, hence the label
 * ("Reading launch-brief.md") rather than an event shape: every engine says it
 * differently and morse says it once.
 */
export interface BotActivity {
  /** Which kind of work it is, for the row's tone and its dots. */
  kind: 'starting' | 'thinking' | 'writing' | 'tool';
  /** The phrase the row shows, already worded for a reader. */
  label: string;
  /** The engine's own tool name, when the work is a tool call (`bash`, `read`, …). */
  tool?: string;
  /** Epoch milliseconds the activity began: a changed `at` restarts the animation. */
  at: number;
  /** A tool's outcome, once known. Absent while it runs; absent on a thought. */
  status?: 'running' | 'ok' | 'error';
  /**
   * What a failed tool said, trimmed to a line the row can open. Absent unless
   * it failed.
   */
  error?: string;
  /**
   * How long a finished tool took, so the record can point at the slow ones.
   * Absent while it runs.
   */
  durationMs?: number;
}

/**
 * One ask a working bot handed to another bot during its turn.
 *
 * The row reads the target's delivery to draw the state, so a handoff moves
 * asked → working → done without the sender's engine sending anything else, and
 * a peer that failed stays visible on the sender's row rather than only in a note
 * elsewhere.
 */
export interface BotHandoff {
  /** The bot that was asked, by handle. */
  username: string;
  /** The thread or room it was asked in, so the row's chip can open it. */
  conversationId: string;
  /** The delivery the ask created: where `state` is read from. */
  deliveryId: string;
  /** Epoch milliseconds the ask was made. */
  at: number;
  /**
   * How far the ask has moved: a queued delivery is `asked`, a running one
   * `working`, a done one `done`, and a failed, dropped or cancelled one `failed`.
   */
  state: 'asked' | 'working' | 'done' | 'failed';
  /** What that bot is doing there right now. Absent when it has no live step. */
  activity?: BotActivity;
}

/**
 * One bot at work in a conversation: its display name, its handle, the steps it
 * has taken and what it is doing now.
 *
 * Both identities travel because a display name is a label and may repeat: two
 * bots can be called "Forge", but only one can be `forge`. A reader is shown
 * `target`; every key — the row's Angular track, its Stop and its ring — uses
 * `username`.
 *
 * The turn so far travels with the row instead of being fetched: a chat opened
 * mid-turn draws the work that already happened, and the answer appears as the
 * bot writes it.
 */
export interface BotRoutingActive {
  /** The bot's display name, for the row's heading. */
  target: string;
  /** The bot's handle: unique, and the only thing a stop takes. */
  username: string;
  activity: BotActivity;
  /** When this turn was taken off the queue, for the row's elapsed count. */
  startedAt: number;
  /** Every step taken so far, newest last and capped at 8; `activity` is the last. */
  steps: BotActivity[];
  /** The asks this turn handed to other bots, so their state moves with the row. */
  handoffs: BotHandoff[];
  /** The answer so far, text channel only. Absent until the bot writes a word. */
  partial?: string;
}

/**
 * One ask this room is waiting on, made by a bot working here.
 *
 * The peer is somewhere else — a private thread, usually — so nothing in this
 * room moves while it works. This is the row that says so, above the composer:
 * who was asked, what they are doing, and where to look.
 */
export interface BotWaitingAsk {
  /** The peer that was asked, by handle. */
  username: string;
  /** Its display name, for the row's heading. */
  target: string;
  /** The conversation the ask landed in, so the row can open it. */
  conversationId: string;
  /** The delivery the ask created: where `state` is read from. */
  deliveryId: string;
  /** Queued at the peer, or already working on it. */
  state: 'asked' | 'working';
  /** Epoch milliseconds the ask was made. */
  at: number;
  /** What that bot is doing there right now. Absent while the ask is still queued. */
  activity?: BotActivity;
}

/**
 * The work in flight on one conversation: every bot answering now, every delivery
 * still waiting, and every peer this room's bots have asked elsewhere.
 *
 * A room can have more than one bot working at once — lanes are per bot, so one
 * bot's turn never holds another's — which is why `active` is a list rather than
 * the single target the host-scheduled round used to have.
 */
export interface BotRoutingState {
  conversationId: string;
  /** Every bot answering right now, in the order their turns started. */
  active: BotRoutingActive[];
  /** Deliveries still queued, by display name, oldest first. */
  queued: string[];
  /**
   * Asks a bot here handed to a peer elsewhere, oldest first. An ask answered in
   * this room is not here: the peer is already visible in it. Absent when nothing
   * is outstanding.
   */
  waiting?: BotWaitingAsk[];
}

/**
 * What one bot in one conversation last reported, in the terms the composer's
 * context ring shows: how full the model's window is and what the engine session
 * spent.
 *
 * A bot answers from its own engine session, so these are one bot's counters and
 * not the conversation's: usage is keyed by `(conversation, bot)`, `username`
 * always names the bot they belong to, and a room with two members holds two
 * sets. The composer draws the one that reported most recently; each presence row
 * draws its own bot's.
 */
export interface BotUsage {
  conversationId: string;
  /** The bot whose engine session these counters belong to, by handle. */
  username: string;
  /** The same bot by display name, for a ring that says whose window it draws. */
  bot?: string;
  usage?: TokenUsage;
  lastUsage?: TokenUsage;
  contextUsage?: ContextUsage;
  costUsd?: number;
  counts?: SessionCounts;
  speed?: SessionSpeed;
  /** The model that engine session runs, for the panel's output cap. */
  model?: ModelOption;
}

/** What the reader attached to one line, when anything was. */
export interface BotOutgoingAttachments {
  images?: PromptImage[];
  files?: BotFileInput[];
}

/** One provider credential the wizard collected, written into the bot's own config. */
export interface BotCredentialInput {
  provider: string;
  apiKey: string;
}

/** The wire protocols Morse can translate into either engine's provider config. */
export type BotProviderApi =
  'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';

/** How a provider authenticates: a key stored in the bot's config, or an env ref. */
export type BotProviderCredentialInput =
  { kind: 'stored'; apiKey: string } | { kind: 'env'; name: string };

/** One discovered or hand-entered model of a provider. */
export interface BotProviderModelInput {
  id: string;
  name?: string;
  /**
   * The model's context window in tokens. Absent writes nothing and leaves the
   * engine's own default in place — which is the honest answer when discovery could
   * not find it, and the reason this field is editable by hand: a wrong automatic
   * value either compacts too early or overflows the model.
   */
  contextWindow?: number;
  /** The provider's cap on one response, same rule as `contextWindow`. */
  maxTokens?: number;
  /**
   * Input modalities this model accepts. Absent means "the engine decides", whose
   * default is usually text-only; `['text', 'image']` is what makes a vision model
   * actually take an image, and what bot mode's paste gate reads.
   */
  input?: ModelInput[];
  /** Whether the model can reason; enables the thinking-level picker. */
  reasoning?: boolean;
  /** Level → the engine's own value; null disables a level (pi writes this map). */
  thinking?: Partial<Record<ThinkingLevel, string | null>>;
  /** Enabled thinking levels (OpenCode writes variants). */
  thinkingLevels?: ThinkingLevel[];
}

/**
 * One provider the wizard collected — the UI equivalent of a `providers.<id>`
 * block the reader would hand-edit into the engine's own config. The host
 * translates it into the bot engine's native shape (OpenCode `providers.<id>`
 * with a runtime `package`; pi's `models.json` `providers.<id>` with `api`).
 */
export interface BotProviderInput {
  /** The engine config key: model references become `<id>/<model>`. */
  id: string;
  label: string;
  api: BotProviderApi;
  /** Absent for catalog providers the engine discovers from its own catalog. */
  baseUrl?: string;
  credential: BotProviderCredentialInput;
  models: BotProviderModelInput[];
}

/** A provider Edit bot can correct without touching credentials. */
export interface BotProviderConfig {
  /** The engine config key: model references become `<id>/<model>`. */
  id: string;
  label: string;
  /** The wire protocol; absent keeps whatever the engine file already says. */
  api?: BotProviderApi;
  baseUrl?: string;
  /**
   * Only on the way in, from a create or from an edit that collected a new key.
   * Absent means "keep what the engine's own store already holds", which is how a
   * correction of model fields never needs the reader to paste a credential again.
   */
  credential?: BotProviderCredentialInput;
  models: BotProviderModelInput[];
}

/** One MCP server the wizard collected for a bot: the same neutral shape a panel reads. */
export type BotMcpServerInput = McpServer;

/** What the New bot wizard sends to create one isolated bot. */
export interface BotCreateInput {
  /**
   * The handle: lowercase letters, digits, dashes and underscores. It names the
   * bot's directory, its `@mention` and its DM conversation, so it is unique and
   * never free text.
   */
  username: string;
  /** What the reader calls it — any characters they like. */
  name: string;
  description: string;
  avatar?: string;
  /** The stable engine kind (`pi`, `opencode`). */
  engineKind: string;
  /** The bot's own credentials; pasted here, or copied from global on request. */
  credentials: BotCredentialInput[];
  /** Use the OpenCode Go login already stored on this machine (OpenCode bots only). */
  useGoAuth?: boolean;
  /**
   * Copy this machine's global engine configuration — stored keys and custom
   * providers — into this bot on submit. A snapshot: the bot keeps its own
   * copy afterwards, so later global changes do not follow it. Anything the
   * wizard collected itself wins on conflict.
   */
  useGlobalConfig?: boolean;
  /** Names of the host's environment variables the bot's engine inherits. */
  envVars: string[];
  /** Values defined only for this bot; they override host variables of the same name. */
  env?: Record<string, string>;
  /** The bot's system prompt, written where its engine keeps system prompts. */
  persona: string;
  model?: ModelOption;
  thinkingLevel?: ThinkingLevel;
  /** The built-in tools this bot may use, in its engine's own names. */
  tools?: string[];
  /** The bot workspace's AGENTS.md, when the wizard collected one. */
  agentsMd?: string;
  /**
   * The bot's named subagents, each with its own system prompt. The host records
   * them on the bot but only hands them to an engine that supports subagents
   * (OpenCode stores them natively in its `agent` config); an engine without them
   * keeps the record alone.
   */
  subagents?: Array<{ name: string; prompt: string }>;
  /** Providers written into the bot's own engine config (spec: Provider management). */
  providers?: BotProviderInput[];
  /** MCP servers the bot carries with it. */
  mcpServers?: BotMcpServerInput[];
}

/**
 * Everything Edit bot fills its form with: the bot's own record as the host
 * stores it, plus the workspace instructions it wrote and the providers its engine
 * config declares. Credentials are not here — an engine keeps them in its own auth
 * store, which Morse never reads back; a provider comes back without one, which is
 * what lets an edit rewrite model fields around a key it never sees again.
 */
export interface BotConfig {
  /** The handle every key uses: the directory, the DM id, the `@mention`. */
  username: string;
  /** What the reader calls it. An edit can change this freely. */
  name: string;
  description: string;
  avatar?: string;
  /** The stable engine kind (`pi`, `opencode`); an edit cannot change it. */
  engineKind: string;
  model?: ModelOption;
  thinkingLevel?: ThinkingLevel;
  persona: string;
  /** Names of the host's environment variables the bot's engine inherits. */
  envVars: string[];
  /** Values this bot alone sets, read back so the form can edit them. */
  env?: Record<string, string>;
  /**
   * The built-in tools this bot may use, in its engine's own names (`read`,
   * `bash`, `edit`, `write` on pi; `read`, `edit`, `bash`, `webfetch`, … on
   * OpenCode). Absent keeps the engine's default set; an empty array means none.
   */
  tools?: string[];
  /** The bot workspace's AGENTS.md, when it has one. */
  agentsMd?: string;
  subagents?: Array<{ name: string; prompt: string }>;
  /**
   * Providers the bot's engine config declares, read back with the model fields a
   * reader can correct: context window, output cap, modalities. Absent when the
   * engine file names none (a catalog provider is the engine's, not the bot's).
   */
  providers?: BotProviderConfig[];
  /** MCP servers the bot carries with it, read back from the engine's own files. */
  mcpServers?: BotMcpServerInput[];
}

/**
 * What Edit bot sends. The name and the engine are fixed: a bot's name is its
 * directory and its `@mention`, and its engine owns the config already written
 * into the bot's tree — changing either is a new bot, not an edit. Credentials
 * are absent on purpose: a blank list keeps the stored ones, and a pasted key
 * replaces them the same way creation does.
 */
export interface BotUpdateInput {
  /** The bot being edited: its handle, which an edit cannot change. */
  username: string;
  /** What the reader calls it; free text, so a rename is always allowed. */
  name: string;
  description: string;
  avatar?: string;
  persona: string;
  model?: ModelOption;
  thinkingLevel?: ThinkingLevel;
  /** The built-in tools this bot may use; absent keeps the engine's default set. */
  tools?: string[];
  envVars: string[];
  /** Explicit map replaces the bot's values, including when emptied; absent keeps them. */
  env?: Record<string, string>;
  agentsMd?: string;
  subagents?: Array<{ name: string; prompt: string }>;
  /** Credentials to write into the bot's config; omitted leaves the stored ones. */
  credentials?: BotCredentialInput[];
  /** Use the machine's OpenCode Go login for this bot (OpenCode bots only). */
  useGoAuth?: boolean;
  /**
   * Copy this machine's current global engine configuration — stored keys and
   * custom providers — into this bot on save. A snapshot: the bot keeps its
   * own copy afterwards. Anything the form collected itself wins on conflict.
   */
  useGlobalConfig?: boolean;
  /**
   * Providers whose model fields the reader corrected — a context window, an output
   * cap, an image modality. Written into the engine's own config around the
   * credentials already there, so an edit never needs the key again.
   */
  providers?: BotProviderConfig[];
  /** MCP servers the bot carries with it; omitted leaves the engine's file alone. */
  mcpServers?: BotMcpServerInput[];
}

/** What the New group dialog sends. */
export interface BotGroupCreateInput {
  name: string;
  members: string[];
  lead?: string;
}

/**
 * What Edit group sends: the same room, with what the reader changed.
 *
 * The fields are a patch, not a merge: an absent `lead` clears the lead (the
 * room then fans an unaddressed message out to every member). The dialog always
 * sends the current form state, so what the reader sees is what is stored.
 */
export interface BotGroupUpdateInput {
  /** The group being edited; its id never changes. */
  id: string;
  name: string;
  members: string[];
  lead?: string;
}
