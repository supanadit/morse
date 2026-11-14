import type { ModelRef, ThinkingLevel } from '@morse/agent';

/**
 * A bot's portable identity, written to `<botRoot>/engine.json`.
 *
 * The registry is the source of truth for which bots exist; this record travels
 * with the bot's own directory, so copying that directory carries the identity
 * along. Engine-native credentials and session storage stay in the sibling
 * `config/` and `sessions/` directories, never here — this file is Morse's
 * view of the bot, not the engine's.
 */
export interface BotRecord {
  name: string;
  description: string;
  avatar?: string;
  engineKind: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  persona: string;
  /**
   * The environment variables holding this bot's credentials, for engines that
   * read keys from the environment rather than a stored auth file.
   */
  credentialEnv: string[];
  /**
   * The bot's named subagents, each with its own system prompt. Kept here as
   * well as in the engine's own config so copying the bot's directory carries
   * what the reader defined, and so a later wizard can show it back. Optional:
   * a bot created before subagents existed simply has none.
   */
  subagents?: Array<{ name: string; prompt: string }>;
}

/**
 * A named set of bots a reader talks to in one conversation. `lead` answers
 * messages that mention nobody, and `chainCap` bounds how many bot-to-bot
 * replies one human message may set off.
 */
export interface GroupRecord {
  id: string;
  name: string;
  members: string[];
  lead?: string;
  chainCap: number;
}

/**
 * Where one bot's engine session for one conversation lives. An absent
 * `engineSessionId` means "start fresh": the next turn opens a new engine
 * session and stores its id here. "New discussion" clears this field rather
 * than the engine's own session files, which stay on disk for the engine.
 */
export interface BotSessionRef {
  engineSessionId?: string;
}

/**
 * One thread as Morse sees it: a DM has a single member, a group many. `sessions`
 * maps each participant's bot name to its engine session for this thread, so a
 * restart resumes where the reader left instead of forking a second session.
 */
export interface ConversationRecord {
  id: string;
  kind: 'dm' | 'group';
  title: string;
  members: string[];
  lead?: string;
  chainCap: number;
  sessions: Record<string, BotSessionRef>;
  updatedAt: number;
}

/**
 * The whole of `registry.json`: bots, groups and conversations in one file.
 *
 * Bot mode has no second Morse session store — this file is the index. The
 * version is pinned so a future reader can tell an older file from a newer one
 * instead of guessing at its shape.
 */
export interface BotRegistryFile {
  version: 1;
  bots: BotRecord[];
  groups: GroupRecord[];
  conversations: ConversationRecord[];
}

/**
 * What an engine integration can do for a bot, so the service and the wizard can
 * branch without knowing the engine by name. `credentials: 'stored'` means the
 * integration writes an auth file into the bot's `config/`; `'env'` means it
 * reads keys from the environment variables named in
 * `BotRecord.credentialEnv`.
 *
 * This lives here, not in the integration packages, because it is the shape
 * every integration must declare and the service consumes.
 */
export interface BotEngineCapabilities {
  supportsSubagents: boolean;
  supportsThinkingLevels: boolean;
  credentials: 'stored' | 'env';
}

/** The wire protocols Morse can translate into either engine's provider config. */
export type BotProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

/** How a provider authenticates: a key stored in the bot's config, or an env ref. */
export type BotProviderCredential =
  | { kind: 'stored'; apiKey: string }
  | { kind: 'env'; name: string };

/** One discovered or hand-entered model of a provider. */
export interface BotProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * One provider the wizard collected — the UI equivalent of a `providers.<id>`
 * block the reader would hand-edit into the engine's own config. Each
 * integration translates it into its native shape (OpenCode `providers.<id>`
 * with a runtime `package`; pi's `models.json` `providers.<id>` with `api`).
 */
export interface BotProviderRecord {
  /** The engine config key: model references become `<id>/<model>`. */
  id: string;
  label: string;
  api: BotProviderApi;
  /** Absent for catalog providers discovered by the engine itself. */
  baseUrl?: string;
  credential: BotProviderCredential;
  models: BotProviderModel[];
}
