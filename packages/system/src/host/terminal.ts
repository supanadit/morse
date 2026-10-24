/**
 * The terminal port (R2): the interface a host implements to actually run a
 * shell. `HostSessionController` owns the wire conversation — ids, streaming,
 * teardown — and delegates the process itself to whoever can spawn one.
 *
 * Kept free of `node:*` so the same controller serves the VS Code host (which
 * leaves the capability off) and the NestJS host (which implements it with
 * `node-pty`).
 */

/** How a terminal is opened. `cwd` is already policy-approved by the host. */
export interface TerminalOpenOptions {
  cwd: string;
  cols: number;
  rows: number;
}

/** Where a terminal's output and end go. Called from the host's process callbacks. */
export interface TerminalSink {
  output(data: string): void;
  /** `code` is the shell's exit status; `error` explains a shell that never ran. */
  exit(code?: number, error?: string): void;
}

/**
 * One viewer's handle on a shell.
 *
 * `detach` ends only the *viewer*: the shell and its scrollback stay with the
 * host, so a reloaded page can attach again (`replay` hands it what it missed).
 * Ending the shell for good is `TerminalBackend.close`.
 */
export interface TerminalSession {
  /** Output produced while nobody was attached; `''` when there is none. */
  readonly replay: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

/**
 * Port (R2) the host owns. `attach` may reject (a directory the policy refuses, a
 * shell that cannot be spawned); the controller turns that into `terminal/exit`
 * with the message, so the panel can say what happened instead of hanging.
 *
 * The backend, not the connection, owns the shell: the same `terminalId` gets the
 * same live shell back across a client reload, and its scrollback is replayed on
 * the next attach. That is what lets a browser refresh keep a running command.
 */
export interface TerminalBackend {
  attach(
    terminalId: string,
    options: TerminalOpenOptions,
    sink: TerminalSink,
  ): TerminalSession | Promise<TerminalSession>;
  /** Ends the shell and forgets its scrollback (the reader closed the pane). */
  close(terminalId: string): void;
}
