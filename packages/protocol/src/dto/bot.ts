/**
 * Bot mode: the roster of isolated bots, their conversations and the lines they
 * exchange. A bot is an agent with its own config, engine and model, so these
 * shapes name those choices per bot instead of borrowing a session's view state.
 */
import type { ModelOption } from './model.js';
import type { ModelInput, ThinkingLevel } from './primitives.js';
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
  /**
   * Providers whose model fields the reader corrected — a context window, an output
   * cap, an image modality. Written into the engine's own config around the
   * credentials already there, so an edit never needs the key again.
   */
  providers?: BotProviderConfig[];
}

/** What the New group dialog sends; `chainCap` defaults to the service's cap. */
export interface BotGroupCreateInput {
  name: string;
  members: string[];
  lead?: string;
  chainCap?: number;
}
