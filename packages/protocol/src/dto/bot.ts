/**
 * Bot mode: the roster of isolated bots, their conversations and the lines they
 * exchange. A bot is an agent with its own config, engine and model, so these
 * shapes name those choices per bot instead of borrowing a session's view state.
 */
import type { ModelOption } from './model.js';
import type { ThinkingLevel } from './primitives.js';

/** One bot in the roster, as the sidebar lists it. */
export interface BotSummary {
  /** The bot's name: unique under `<dataDir>/bot/<name>/`, and its `@mention`. */
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
  /** Member bot names; a mention-less group round addresses them in this order. */
  members: string[];
  /** The bot that answers when nothing is addressed, when the group crowned one. */
  lead?: string;
  /** Bot-to-bot relays allowed per user message; the round stops here with a note. */
  chainCap: number;
  updatedAt: number;
}

/** Who said one transcript line: the reader, a named bot, or Morse itself. */
export type BotAuthor =
  | { role: 'user' }
  | { role: 'bot'; name: string; avatar?: string }
  | { role: 'system' };

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

/** The round in flight on one conversation: whom the host asks, and whom it queued. */
export interface BotRoutingState {
  conversationId: string;
  /** The bot answering now; absent when the round has not started or has settled. */
  target?: string;
  /** Bots addressed after the current one, in the order they will speak. */
  queued: string[];
}

/** One provider credential the wizard collected, written into the bot's own config. */
export interface BotCredentialInput {
  provider: string;
  apiKey: string;
}

/** What the New bot wizard sends to create one isolated bot. */
export interface BotCreateInput {
  name: string;
  description: string;
  avatar?: string;
  /** The stable engine kind (`pi`, `opencode`). */
  engineKind: string;
  /** The bot's own credentials; never copied from the reader's global config. */
  credentials: BotCredentialInput[];
  /** Names of the host's environment variables the bot's engine inherits. */
  envVars: string[];
  /** The bot's system prompt, delivered on its session's first prompt. */
  persona: string;
  model?: ModelOption;
  thinkingLevel?: ThinkingLevel;
  /** The bot workspace's AGENTS.md, when the wizard collected one. */
  agentsMd?: string;
  /**
   * The bot's named subagents, each with its own system prompt. The host records
   * them on the bot but only hands them to an engine that supports subagents
   * (OpenCode stores them natively in its `agent` config); an engine without them
   * keeps the record alone.
   */
  subagents?: Array<{ name: string; prompt: string }>;
}

/** What the New group dialog sends; `chainCap` defaults to the service's cap. */
export interface BotGroupCreateInput {
  name: string;
  members: string[];
  lead?: string;
  chainCap?: number;
}
