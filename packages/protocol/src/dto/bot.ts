/**
 * Bot mode: the roster of isolated bots, their conversations and the lines they
 * exchange. A bot is an agent with its own config, engine and model, so these
 * shapes name those choices per bot instead of borrowing a session's view state.
 */
import type { ModelOption } from './model.js';
import type { ThinkingLevel } from './primitives.js';

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

/** One conversation in the roster: a DM with a bot, or a group of bots. */
export interface BotConversationSummary {
  id: string;
  kind: 'dm' | 'group';
  title: string;
  /** Member bot usernames; a mention-less group round addresses them in this order. */
  members: string[];
  /** The bot that answers when nothing is addressed, by username. */
  lead?: string;
  /** Bot-to-bot relays allowed per user message; the round stops here with a note. */
  chainCap: number;
  updatedAt: number;
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
  | { role: 'user' }
  | { role: 'bot'; name: string; username?: string; avatar?: string }
  | { role: 'system' }
  | { role: 'discussion' };

/**
 * One line of a bot conversation. Tool activity stays out of the transcript; a
 * routing notice or a chain-cap note is a `system` line, not chat.
 */
export interface BotTranscriptEntry {
  id: string;
  author: BotAuthor;
  text: string;
  at: number;
}

/**
 * What a bot is doing this moment, in the reader's words.
 *
 * A chat shows presence, not a trace: the line is replaced by whatever the bot
 * moves on to and disappears with the answer, so nothing here is ever appended
 * to the transcript. The host is the one that knows what an engine's events
 * mean, hence the label ("Reading launch-brief.md") rather than an event shape:
 * every engine says it differently and morse says it once.
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
}

/** The round in flight on one conversation: whom the host asks, and whom it queued. */
export interface BotRoutingState {
  conversationId: string;
  /**
   * The bot answering now, by display name — this strip is presentation, so it
   * reads the way the roster does. Identity travels as `username` everywhere it
   * is a key; an absent target means the round has not started or has settled.
   */
  target?: string;
  /** Bots addressed after the current one, in the order they will speak. */
  queued: string[];
  /** What the target is doing right now; absent until it reports, and after it says. */
  activity?: BotActivity;
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
  contextWindow?: number;
  maxTokens?: number;
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
  /** The bot's own credentials; never copied from the reader's global config. */
  credentials: BotCredentialInput[];
  /** Names of the host's environment variables the bot's engine inherits. */
  envVars: string[];
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
}

/**
 * Everything Edit bot fills its form with: the bot's own record as the host
 * stores it, plus the workspace instructions it wrote. Credentials are not here
 * — an engine keeps them in its own auth store, which Morse never reads back —
 * and neither are providers, which live in the engine's config file.
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
  /**
   * The built-in tools this bot may use, in its engine's own names (`read`,
   * `bash`, `edit`, `write` on pi; `read`, `edit`, `bash`, `webfetch`, … on
   * OpenCode). Absent keeps the engine's default set; an empty array means none.
   */
  tools?: string[];
  /** The bot workspace's AGENTS.md, when it has one. */
  agentsMd?: string;
  subagents?: Array<{ name: string; prompt: string }>;
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
  agentsMd?: string;
  subagents?: Array<{ name: string; prompt: string }>;
  /** Credentials to write into the bot's config; omitted leaves the stored ones. */
  credentials?: BotCredentialInput[];
}

/** What the New group dialog sends; `chainCap` defaults to the service's cap. */
export interface BotGroupCreateInput {
  name: string;
  members: string[];
  lead?: string;
  chainCap?: number;
}
