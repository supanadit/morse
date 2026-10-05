/**
 * The terminal port (R2): the interface a host implements to actually run a
 * shell. `HostSessionController` owns the wire conversation — ids, streaming,
 * teardown — and delegates the process itself to whoever can spawn one.
 *
 * Kept free of `node:*` so the same controller serves the VS Code host (which
 * leaves the capability off) and the NestJS host (which implements it with
 * `child_process`).
 */

/** How a terminal is opened. `cwd` is already policy-approved by the host. */
export interface TerminalOpenOptions {
  cwd: string;
  cols: number;
  rows: number;
}

/** The running shell behind one terminal id. */
export interface TerminalProcess {
  /** Writes keystrokes (or a whole pasted line) to the shell's stdin. */
  write(data: string): void;
  /** Tells the shell the viewer's new size; a no-op for a pipe-only shell. */
  resize(cols: number, rows: number): void;
  /** Ends the shell. Safe to call more than once. */
  kill(): void;
}

/** Where a terminal's output and end go. Called from the host's process callbacks. */
export interface TerminalSink {
  output(data: string): void;
  /** `code` is the shell's exit status; `error` explains a shell that never ran. */
  exit(code?: number, error?: string): void;
}

/**
 * Port (R2) the host owns. `open` may reject (a directory the policy refuses, a
 * shell that cannot be spawned); the controller turns that into `terminal/exit`
 * with the message, so the panel can say what happened instead of hanging.
 */
export interface TerminalBackend {
  open(options: TerminalOpenOptions, sink: TerminalSink): TerminalProcess | Promise<TerminalProcess>;
}
