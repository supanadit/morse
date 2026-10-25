import type {
  AgentEventListener,
  AgentGateway,
  AgentHistoryPage,
  PromptDisposition,
  PromptMode,
} from './ports.js';
import type {
  AgentEvent,
  AgentForkMessage,
  AgentInteractionResponse,
  AgentSessionState,
  ChatPin,
  ModelRef,
  PromptImage,
  ThinkingLevel,
} from './domain/index.js';

/** The part of `MorseLogger` a session needs; `silentLogger` satisfies it. */
export interface SessionLogger {
  error(message: string, detail?: unknown): void;
}

/**
 * The abstract session: one conversation with an agent, whatever harness is
 * behind it.
 *
 * This is the class `@morse/integration-pi` extends and the class a host hands to
 * `SessionRegistry`. An adapter writes only what is genuinely engine-specific —
 * spawn, RPC framing, event mapping — and inherits the three things every session
 * must get right the same way:
 *
 * - one listener set, so `subscribe` cannot leak or double-fire;
 * - a listener that throws is logged, never allowed to break the event loop the
 *   other listeners and the session's own state depend on;
 * - the session's `AgentSessionState` lives in one place, so `state()` cannot
 *   disagree with the last event a client saw.
 *
 * Written as a class rather than a port interface because that behaviour *is* the
 * contract: an interface would leave every adapter to re-implement the listener
 * fan-out, and they would drift (this repo already had two copies of it, in
 * `PiRpcAgent` and in `SessionRegistry.absorb`).
 *
 * The state is mutated in place by the subclass (`box`) and published at the
 * points it chooses, because an engine decides when a snapshot is worth an event;
 * `state()` returns a copy, because a caller sorts and appends to those arrays.
 */
export abstract class Session implements AgentGateway {
  /** The `AgentEngineRef.engine` value this session's records carry. */
  abstract readonly kind: string;

  // The engine-specific half of the port. Every one of these is a different
  // answer per harness, so none can be inherited; they are declared here only so
  // `implements AgentGateway` holds and a subclass cannot forget one.
  abstract history(options?: { limit?: number; before?: string }): Promise<AgentHistoryPage>;
  abstract prompt(
    text: string,
    mode: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
  ): Promise<PromptDisposition>;
  abstract forkMessages(): Promise<AgentForkMessage[]>;
  abstract fork(entryId: string): Promise<{ text: string; cancelled: boolean }>;
  abstract abort(): Promise<void>;
  abstract setModel(model: ModelRef): Promise<void>;
  abstract setThinkingLevel(level: ThinkingLevel): Promise<void>;
  abstract compact(customInstructions?: string): Promise<void>;
  abstract respondToInteraction(response: AgentInteractionResponse): Promise<void>;
  abstract dispose(): Promise<void>;

  private readonly listeners = new Set<AgentEventListener>();
  private current: AgentSessionState;

  /**
   * `initialState` is required rather than optional: a session always knows its
   * workspace and its defaults before it spawns anything, and making it explicit
   * is what lets `state()` never fail on a session that has not started yet.
   */
  constructor(
    protected readonly logger: SessionLogger,
    initialState: AgentSessionState,
  ) {
    this.current = initialState;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The session's current state, copied.
   *
   * A copy, not the field: a caller that sorts `availableModels` in place, or a
   * frontend adapter that appends to `availableCommands`, would otherwise rewrite
   * the session's own state through a value it only meant to read.
   *
   * An engine that must ask its backend first (pi's `get_state`) overrides this
   * and calls `setState()` before delegating to `super.state()`.
   */
  async state(): Promise<AgentSessionState> {
    return cloneState(this.current);
  }

  /**
   * The mutable state, for subclass use only.
   *
   * Not copied: this is called on every event, and the subclass is the one writer.
   * Anything handed to a listener goes through `state()` or `emitState()`, both of
   * which copy.
   */
  protected get box(): AgentSessionState {
    return this.current;
  }

  /** Replaces the whole state without emitting. Pair it with `emitState`/`emitReady`. */
  protected setState(next: AgentSessionState): void {
    this.current = next;
  }

  /** Merges a patch into the state without emitting. */
  protected mergeState(patch: Partial<AgentSessionState>): void {
    this.current = { ...this.current, ...patch };
  }

  /** Merges a patch and tells every listener, for one event's incremental change. */
  protected patch(patch: Partial<AgentSessionState>, at: number): void {
    this.mergeState(patch);
    this.emitState(at);
  }

  /** Tells every listener the current state, without changing it. */
  protected emitState(at: number): void {
    this.emit({ type: 'agent/state', at, state: cloneState(this.current) });
  }

  /**
   * Announces that the session is ready, with its state.
   *
   * A separate event from `agent/state` on purpose: hosts key "the agent came up"
   * off this one, and folding it into `agent/state` would make them infer a
   * lifecycle from a value.
   */
  protected emitReady(at: number): void {
    this.emit({ type: 'agent/ready', at, state: cloneState(this.current) });
  }

  /**
   * Sends one event to every listener.
   *
   * A throwing listener is reported and skipped: one host's faulty handler must
   * not stop the session's own event stream, which every other listener and the
   * warm transcript are reading.
   */
  protected emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.logger.error('Agent event listener failed', { error });
      }
    }
  }

  /** Drops every listener, for a `dispose` that must not leave them subscribed. */
  protected clearListeners(): void {
    this.listeners.clear();
  }
}

/**
 * A copy deep enough that a client cannot observe a later mutation of arrays the
 * session keeps (models, commands, widgets, statuses). One level plus the nested
 * arrays of the two types that own one (`widgets.lines`): everything else in
 * `AgentSessionState` is a string, a number or a flat record.
 */
function cloneState(state: AgentSessionState): AgentSessionState {
  return {
    ...state,
    workspace: { ...state.workspace },
    availableModels: [...state.availableModels],
    availableThinkingLevels: [...state.availableThinkingLevels],
    availableCommands: [...state.availableCommands],
    ...(state.availableModes === undefined
      ? {}
      : { availableModes: state.availableModes.map((mode) => ({ ...mode })) }),
    ...(state.diagnostics === undefined ? {} : { diagnostics: [...state.diagnostics] }),
    ...(state.widgets === undefined
      ? {}
      : { widgets: state.widgets.map((widget) => ({ ...widget, lines: [...widget.lines] })) }),
    ...(state.statuses === undefined
      ? {}
      : { statuses: state.statuses.map((status) => ({ ...status })) }),
  };
}
