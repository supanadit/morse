export class MorseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** What the user can do about a failure, when the layer that failed knows. */
export interface AgentRemedy {
  /** Shell command that installs what is missing, e.g. the pi CLI. */
  install?: string;
}

/** The agent backend could not be started (missing `pi` binary, spawn failure, ...). */
export class AgentUnavailableError extends MorseError {
  /**
   * The next step, in a form a frontend can render (see `SessionViewState
   * .agentFailure`). The message stays human-readable on its own; this is the
   * machine-readable half, and only the layer that knows pi's package name can
   * fill it in.
   */
  readonly remedy: AgentRemedy | undefined;

  constructor(message: string, options?: { cause?: unknown; remedy?: AgentRemedy }) {
    super(message, 'agent-unavailable', options);
    this.remedy = options?.remedy;
  }
}

/** The agent answered with something the adapter could not understand. */
export class AgentProtocolError extends MorseError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'agent-protocol', options);
  }
}

/** The host was asked to do something it cannot do (server host has no editor). */
export class UnsupportedByHostError extends MorseError {
  constructor(message: string) {
    super(message, 'unsupported-by-host');
  }
}
