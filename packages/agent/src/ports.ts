import type {
  AgentEvent,
  AgentHistoryEntry,
  AgentInteractionResponse,
  AgentSessionState,
  AgentUserMessage,
  ChatPin,
  ModelRef,
  PromptImage,
  ThinkingLevel,
  WorkspaceRef,
} from './domain/index.js';

/**
 * The ports a harness implements, and the shapes its callers exchange with it.
 *
 * Part of the harness contract: nothing here names a Morse application symbol, so
 * an adapter can depend on `@morse/agent` alone.
 */

/** Re-exported so the chat use case (and older imports) keep their import path. */
export type { PromptImage };

export type PromptMode = 'new' | 'steer' | 'followUp';

export type PromptDisposition = 'started' | 'queued' | 'handled';

export type AgentEventListener = (event: AgentEvent) => void;

/**
 * Driven port (R2): the coding agent Morse drives, one instance per session.
 * Declared in the module that owns the gateway lifetime, implemented by
 * `@morse/integration-pi` (subprocess) — or an SDK adapter later.
 */
export interface AgentGateway {
  /** The `AgentEngineRef.engine` value this session's records carry. */
  readonly kind: string;
  subscribe(listener: AgentEventListener): () => void;
  state(): Promise<AgentSessionState>;
  /**
   * Finished exchanges of a resumed session (empty for a new one), newest page
   * first. Page from the end so a large session opens without loading it all.
   */
  history(options?: { limit?: number; before?: string }): Promise<AgentHistoryPage>;
  prompt(
    text: string,
    mode: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
  ): Promise<PromptDisposition>;
  /**
   * Every user message the session holds, in conversation order. Rewriting or
   * forking names one of these entries, so a frontend turns "edit my old prompt"
   * into an operation on an entry id the engine understands.
   */
  userMessages(): Promise<AgentUserMessage[]>;
  /**
   * Rewrites the conversation the way this engine can: in place from `entryId`
   * forward (same session id) or by branching before it (new session id). Returns
   * the text of the message that was dropped.
   */
  rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }>;
  /** Branches at the tip: a new session copying this conversation through the last message. */
  clone(): Promise<{ cancelled: boolean }>;
  /**
   * Optional: forget a cached first read of the conversation, so the next
   * `history()` re-reads the source. A watched session is written by someone
   * else (a subagent's parent process), and a reader asking for the latest must
   * not be served the snapshot taken when this gateway attached. Adapters that
   * never cache simply omit it.
   */
  refreshHistory?(): Promise<void>;
  /**
   * Re-parents the conversation before `entryId`, discarding that message and
   * everything after it, and returns the message text that was dropped. The
   * agent keeps running, but its session id changes: a fork is a new session.
   */
  fork(entryId: string): Promise<{ text: string; cancelled: boolean }>;
  abort(): Promise<void>;
  /**
   * Stops a session this agent spawned, whose engine id the router knows.
   * Optional: an engine without background children never needs one.
   */
  abortChild?(childSessionId: string): Promise<void>;
  /**
   * Re-reads the commands the agent exposes — prompt templates especially, which
   * pi caches at spawn. Optional: an adapter that cannot re-read resources simply
   * omits it and the palette keeps what the last `state()` reported.
   */
  refreshCommands?(): Promise<void>;
  /**
   * Optional: re-reads the model catalog for this session. The model picker
   * calls it when it opens, so a model added to `models.json` while the host
   * runs shows up without restarting the host or the session. Adapters that
   * cannot re-read the catalog simply omit it.
   */
  refreshModels?(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /**
   * Optional: moves a running session to another mode the harness offers. A
   * harness with no named modes omits it and the application offers no switch.
   */
  setMode?(mode: string): Promise<void>;
  /**
   * Optional: re-reads the modes the harness offers, so a mode added to the
   * agent's configuration becomes selectable without restarting the session.
   */
  refreshModes?(): Promise<void>;
  /**
   * Optional: re-reads everything the harness keeps in its own configuration —
   * models, agents/modes, commands and skills — for a session that is already
   * warm. The manual "reload agent configuration" control calls it after the
   * engine reloaded, so an edited config reaches this conversation without the
   * reader restarting the host. Adapters with no engine-level configuration
   * simply omit it.
   */
  refreshConfig?(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  respondToInteraction(response: AgentInteractionResponse): Promise<void>;
  dispose(): Promise<void>;
}

/** Driven port (R2): creates a gateway for a workspace / persisted session. */
export interface AgentGatewayFactory {
  /**
   * Optional: the engine kind this factory's engine is for when a caller has no
   * choice yet — a fresh draft with no engine picked. A host with one registered
   * default engine answers with it; a router that owns several engines exposes
   * the same kind through its own getter.
   */
  readonly defaultEngineKind?: string;
  create(options: {
    workspace: WorkspaceRef;
    sessionId?: string;
    /** The mode the new session should start in, when the caller chose one. */
    mode?: string;
  }): Promise<AgentGateway>;
  /**
   * Optional: a gateway that never records — pi spawned with `--no-session` —
   * used only to read what the backend offers before any session exists (model
   * catalog, thinking levels, commands). Adapters without a session-less mode
   * omit it, and the draft state simply ships without a catalog. `engine` asks
   * for a specific registered engine's catalogs (the draft's choice), `model`
   * asks for the levels of a specific model, and `mode` asks for the model and
   * levels of the mode the draft has picked, so the pickers can follow choices
   * the user made before the session exists.
   */
  probeDefaults?(options: {
    workspace: WorkspaceRef;
    engine?: string;
    model?: ModelRef;
    mode?: string;
  }): Promise<AgentGateway>;
  /**
   * Optional: the fingerprint of every config file `workspace.cwd` reads right
   * now. A caller compares it to decide whether its cached draft catalogs are
   * stale, because a config edit reaches the engine only when it reloads.
   * Synchronous on purpose: a cache lookup cannot await a stat walk. Adapters
   * whose engine has no config file simply omit it.
   */
  configSignature?(options: { workspace: WorkspaceRef; engine?: string }): string;
  /**
   * Optional: tells the engine to re-read its configuration — for an attached
   * server too, since this is the explicit request. `cwd` names the workspace
   * whose files changed, when the caller knows it; `engine` names the engine
   * when the caller's draft has no session to ask. The manual control calls
   * this, and it must work while sessions are running.
   *
   * Resolves `false` when this engine has no configuration to reload, so a
   * caller that always reaches a factory (a router owning several engines) can
   * report an honest "nothing was re-read" instead of a false success. `true`
   * or no value means the reload was performed — or attempted, with the adapter
   * logging a failure rather than throwing.
   */
  reloadConfig?(options: { engine?: string; cwd?: string }): Promise<boolean | void>;
}

/** One page of a resumed session's finished exchanges. */
export interface AgentHistoryPage {
  entries: AgentHistoryEntry[];
  /** True when entries exist before this page. */
  hasOlder: boolean;
  /** Opaque cursor to pass as `before` for the next older page. */
  before?: string;
}
