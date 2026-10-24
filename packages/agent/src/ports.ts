import type {
  AgentEvent,
  AgentForkMessage,
  AgentHistoryEntry,
  AgentInteractionResponse,
  AgentSessionState,
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
   * Past user messages the agent can fork from, in conversation order. A
   * frontend uses this to turn "edit my old prompt" into a fork of that entry.
   */
  forkMessages(): Promise<AgentForkMessage[]>;
  /**
   * Re-parents the conversation before `entryId`, discarding that message and
   * everything after it, and returns the message text that was dropped. The
   * agent keeps running, but its session id changes: a fork is a new session.
   */
  fork(entryId: string): Promise<{ text: string; cancelled: boolean }>;
  abort(): Promise<void>;
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
  compact(customInstructions?: string): Promise<void>;
  respondToInteraction(response: AgentInteractionResponse): Promise<void>;
  dispose(): Promise<void>;
}

/** Driven port (R2): creates a gateway for a workspace / persisted session. */
export interface AgentGatewayFactory {
  create(options: { workspace: WorkspaceRef; sessionId?: string }): Promise<AgentGateway>;
  /**
   * Optional: a gateway that never records — pi spawned with `--no-session` —
   * used only to read what the backend offers before any session exists (model
   * catalog, thinking levels, commands). Adapters without a session-less mode
   * omit it, and the draft state simply ships without a catalog. `model` asks
   * the probe for the levels of a specific model, so the draft picker can follow
   * a model the user selected before the session exists.
   */
  probeDefaults?(options: { workspace: WorkspaceRef; model?: ModelRef }): Promise<AgentGateway>;
}

/** One page of a resumed session's finished exchanges. */
export interface AgentHistoryPage {
  entries: AgentHistoryEntry[];
  /** True when entries exist before this page. */
  hasOlder: boolean;
  /** Opaque cursor to pass as `before` for the next older page. */
  before?: string;
}

