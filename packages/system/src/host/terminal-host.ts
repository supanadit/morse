import type { MorseLogger } from '@morse/system';
import type { HostToClientMessage } from '@morse/protocol';
import { clampGeometry, describeTerminalError } from './session-helpers.js';
import type { TerminalBackend, TerminalSession } from './terminal.js';

/**
 * What a terminal host needs from the controller it serves: the backend, where
 * messages go, where a failed open is logged, and the directory a client that
 * names none is looking at.
 */
export interface TerminalHostPort {
  readonly backend: TerminalBackend | undefined;
  readonly emit: (message: HostToClientMessage) => void;
  readonly logger: MorseLogger;
  /** The viewing session's cwd, used when an open names no directory. */
  readonly currentCwd: () => string;
}

export class TerminalHost {
  /** This client's live attachments to shells, keyed by the terminal id it named. */
  private readonly terminals = new Map<string, TerminalSession>();
  /**
   * The ids this connection has already opened. It separates a *first* open — a
   * page reattaching to a shell the host still runs — from a repeat open (the
   * Restart button), which must replace the shell and clear its scrollback
   * instead of replaying it into the emulator that already shows it.
   */
  private readonly openedTerminals = new Set<string>();
  /**
   * Bumped whenever a terminal id is opened or closed. A shell's late `exit`
   * (a replaced one, a killed one) compares its generation and stays silent, so
   * it cannot delete or report over the shell now holding the id.
   */
  private readonly terminalGenerations = new Map<string, number>();
  private disposed = false;

  constructor(private readonly port: TerminalHostPort) {}

  /** Forwards a keystroke to the shell this client named, if it is attached. */
  write(terminalId: string, data: string): void {
    this.terminals.get(terminalId)?.write(data);
  }

  /** Resizes the shell this client named, if it is attached. */
  resize(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.resize(cols, rows);
  }

  /**
   * Attaches this client to a shell for the bottom panel. The directory is the
   * viewing session's (or the draft's), never an arbitrary path the client
   * names — the backend still re-checks it against the host policy before
   * spawning.
   *
   * A *first* open on this connection may land on a shell that is already running
   * (a reloaded page reattaching); a repeat open (the Restart button) replaces
   * it, scrollback and all, so the fresh shell does not replay the old one.
   */
  async open(payload: {
    terminalId: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<void> {
    const backend = this.port.backend;
    if (backend === undefined) {
      this.emitExit(payload.terminalId, undefined, 'This host has no terminal.');
      return;
    }
    // A repeat open on this connection is a *reattach*: a pane that remounted
    // (a rebuilt view) is asking for the shell it already has, not a new one.
    // Detach the superseded viewer only; `attach` below reuses the live shell
    // and replays what that viewer missed. A shell that already exited is the
    // other case — there the dead scrollback is dropped so a fresh shell does
    // not replay it over the emulator that still shows it.
    const previous = this.terminals.get(payload.terminalId);
    if (previous !== undefined) {
      previous.detach();
      this.terminals.delete(payload.terminalId);
    } else if (this.openedTerminals.has(payload.terminalId)) {
      // A restart after the shell exited: drop the dead shell's scrollback, so
      // the fresh shell does not replay it over the emulator that still has it.
      backend.close(payload.terminalId);
    }
    this.openedTerminals.add(payload.terminalId);
    // Any pending exit for a superseded shell is now stale.
    const generation = (this.terminalGenerations.get(payload.terminalId) ?? 0) + 1;
    this.terminalGenerations.set(payload.terminalId, generation);

    const cwd = payload.cwd ?? this.port.currentCwd();
    const cols = clampGeometry(payload.cols, 80);
    const rows = clampGeometry(payload.rows, 24);
    let session: TerminalSession;
    try {
      session = await backend.attach(
        payload.terminalId,
        { cwd, cols, rows },
        {
          output: (data) => {
            if (this.terminalGenerations.get(payload.terminalId) === generation) {
              this.emitOutput(payload.terminalId, data);
            }
          },
          exit: (code, error) => {
            // A shell replaced or closed after this one opened is not the shell
            // the client is looking at; its end is not news.
            if (this.terminalGenerations.get(payload.terminalId) !== generation) {
              return;
            }
            this.terminals.delete(payload.terminalId);
            this.emitExit(payload.terminalId, code, error);
          },
        },
      );
    } catch (error: unknown) {
      this.port.logger.warn('Failed to open a terminal', error);
      this.emitExit(payload.terminalId, undefined, describeTerminalError(error));
      return;
    }
    // The client may have closed it while `attach` was still awaiting the shell.
    if (!this.disposed && this.terminalGenerations.get(payload.terminalId) === generation) {
      this.terminals.set(payload.terminalId, session);
      // Catch the viewer up before the shell's next chunk: what it missed while
      // no page was attached is the whole point of a surviving terminal.
      if (session.replay.length > 0) {
        this.emitOutput(payload.terminalId, session.replay);
      }
    } else {
      // Nobody is watching any more: leave the shell running for the next attach.
      session.detach();
    }
  }

  /**
   * Ends a shell for good: the reader closed the pane. Bumps the generation first,
   * so a late `exit` for the shell being replaced is not reported as news.
   */
  close(terminalId: string): void {
    this.terminalGenerations.set(terminalId, (this.terminalGenerations.get(terminalId) ?? 0) + 1);
    const session = this.terminals.get(terminalId);
    this.terminals.delete(terminalId);
    this.openedTerminals.delete(terminalId);
    session?.detach();
    this.port.backend?.close(terminalId);
  }

  /** Ends this connection's view of every shell, without killing any of them. */
  dispose(): void {
    this.disposed = true;
    // Detach, do not kill: the shell and its scrollback belong to the host now,
    // so a reloaded page (a browser refresh) can attach to the same process. An
    // explicit `terminal/close` is the only thing that ends a shell.
    for (const session of this.terminals.values()) {
      session.detach();
    }
    this.terminals.clear();
    this.terminalGenerations.clear();
    // The next connection is a new viewer, so every id is a first open again.
    this.openedTerminals.clear();
  }

  private emitOutput(terminalId: string, data: string): void {
    if (data.length > 0 && !this.disposed) {
      this.port.emit({
        type: 'terminal/output',
        payload: { terminalId, data },
      });
    }
  }

  private emitExit(terminalId: string, code?: number, error?: string): void {
    if (!this.disposed) {
      this.port.emit({
        type: 'terminal/exit',
        payload: { terminalId, code, error },
      });
    }
  }
}
