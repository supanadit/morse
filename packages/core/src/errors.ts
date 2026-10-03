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

/** The agent backend could not be started (missing `pi` binary, spawn failure, ...). */
export class AgentUnavailableError extends MorseError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'agent-unavailable', options);
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
