import type { ModelRef, ThinkingLevel } from '@morse/agent';

/**
 * A bot's portable identity, written to `<botRoot>/engine.json`.
 *
 * The registry is the source of truth for which bots exist; this record travels
 * with the bot's own directory, so copying that directory carries the identity
 * along. It is an index entry and nothing more: the model, the persona, the
 * keys, the providers and the subagents all live in the engine's own files under
 * `config/` (see `BotEngineLayout`), exactly where that engine expects to find
 * them when a person configures it by hand.
 */
export interface BotRecord {
  /**
   * The bot's handle: lowercase letters, digits, dashes and underscores. It names
   * the bot's directory, its `@mention` and its DM conversation id, so it is the
   * identity every key uses — and it never contains free text.
   */
  username: string;
  /** What the reader calls it. Free text, spaces and emoji included. */
  name: string;
  description: string;
  avatar?: string;
  engineKind: string;
  /**
   * The environment variables this bot's engine inherits from the host. Not
   * engine configuration — it is the process environment — which is why it is
   * the one engine-related field Morse keeps here.
   */
  credentialEnv: string[];
}

/**
 * A named set of bots a reader talks to in one conversation. `lead` answers
 * messages that mention nobody, and `chainCap` bounds how many bot-to-bot
 * replies one human message may set off. Members are bot usernames.
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
  /** The group's name, or the bot's display name for a DM. */
  title: string;
  /** Member bot usernames; a DM has exactly one. */
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
  /** 2 added `username` to every bot; a 1 file is migrated as it is read. */
  version: 2;
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

/**
 * Everything a bot's engine needs, in engine-agnostic terms.
 *
 * This is the wizard's answers, not a file format: each integration's
 * `BotEngineLayout` turns it into that engine's own configuration — the files
 * the engine reads when a person configures it by hand. Morse keeps no copy of
 * the result; the engine's tree is the source of truth, and `read` is how the
 * UI shows back what is really there.
 */
export interface BotEngineConfig {
  /** The handle: the bot's `@mention`, its directory and its DM id. */
  username: string;
  /** What the reader calls it. Engines that show a display name get this one. */
  name: string;
  description: string;
  /** The bot's system prompt / persona, written where the engine puts prompts. */
  persona: string;
  /** The workspace document, written where the engine looks for `AGENTS.md`. */
  agentsMd?: string;
  /** Provider keys the wizard collected. Each engine stores them its own way. */
  credentials: { provider: string; apiKey: string }[];
  /** Provider and model overrides, in the engine's own provider config. */
  providers: readonly BotProviderRecord[];
  /**
   * The model the bot runs on. `undefined` means "leave whatever the engine
   * already has" — the safe answer when a caller (a repair, a reconcile) does not
   * know the bot's choice — while an explicit `null` clears it back to the
   * engine's default. The distinction exists because a write that silently
   * dropped a model would reset a working bot.
   */
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel;
  /**
   * The built-in tools this bot may use, in the engine's own names. Absent keeps
   * the engine's default set — which is not empty on any engine Morse ships: a bot
   * without `read`/`bash` cannot look at anything. An empty array means none.
   */
  tools?: string[];
  subagents?: Array<{ name: string; prompt: string }>;
}

/** What a layout can read back out of an engine's own tree. */
export interface BotEngineState {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  /** The tools the engine's own config allows, when it says so explicitly. */
  tools?: string[];
  persona?: string;
  agentsMd?: string;
  subagents?: Array<{ name: string; prompt: string }>;
}

/**
 * One engine's configuration layout: where it keeps its settings, what each
 * file is called and what goes in it.
 *
 * Morse is a thin wrapper over an engine, not a second configuration system. A
 * layout is the whole engine-specific knowledge in one place: `write` produces
 * the engine's own files (an `opencode.json` that matches opencode.ai/config.json,
 * pi's `auth.json`/`models.json`/`settings.json` under `PI_CODING_AGENT_DIR`,
 * each engine's own `AGENTS.md` location), and `read` answers the wizard's Edit
 * form from those files instead of from a copy Morse kept.
 */
export interface BotEngineLayout {
  /** Writes the bot's whole configuration, in the engine's own layout. */
  write(botRoot: string, config: BotEngineConfig): void;
  /** Reads back the parts a reader can edit, from the engine's own files. */
  read(botRoot: string): BotEngineState;
  /**
   * Moves files an earlier Morse wrote into the places this engine actually
   * reads, when it learns they were wrong.
   *
   * Optional because most engines never need it. It exists because the mapping
   * from "what the reader typed" to "which file the engine reads" is engine
   * knowledge, and a mistake in it cannot be fixed for existing bots by writing
   * the new file alone — the old one may shadow it (`SYSTEM.md` versus
   * `AGENTS.md` in pi, `agents` versus `agent` in OpenCode). Called once by the
   * data migration, never on a normal start.
   */
  repair?(botRoot: string): void;
}
