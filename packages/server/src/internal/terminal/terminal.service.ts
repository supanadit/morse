import { spawn as spawnPty, type IPty } from 'node-pty';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { UnsupportedByHostError, type MorseLogger } from '@morse/core';
import {
  TERMINAL_BUFFER_CHARS,
  trimTail,
  type TerminalBackend,
  type TerminalOpenOptions,
  type TerminalSession,
  type TerminalSink,
} from '@morse/host-runtime';
import type { MorseServerConfig } from '../../app/config.js';
import { MORSE_CONFIG, MORSE_LOGGER, MORSE_PROJECT_POLICY } from '../../app/tokens.js';
import type { ServerProjectPolicy } from '../projects/project-policy.js';
import { readTerminalLog, removeTerminalLog, writeTerminalLog } from './terminal-log.js';

/** How long a shell gets to exit on kill before it is killed outright. */
const SIGKILL_AFTER_MS = 1_500;
/**
 * How long the shutdown waits for a shell's last words. A dev server prints its
 * shutdown log *after* it gets the signal, so persisting the buffer before the
 * kill would drop exactly the lines the reader is looking at. Well under the
 * `morse stop` grace (5 s) before SIGKILL.
 */
const SHUTDOWN_GRACE_MS = 500;
/** How often the streaming scrollback is written down. A shell can output fast. */
const FLUSH_DEBOUNCE_MS = 2_000;

/** The user's shell, falling back per platform when `$SHELL` is not set. */
function defaultShell(): string {
  const configured = process.env.SHELL?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
}

/**
 * The environment a terminal's shell starts with: the user's own, with Morse's
 * variables removed.
 *
 * The server is a child of `morse start` (or `npm run dev`) and inherits
 * `MORSE_PORT`, `MORSE_WORKSPACE`, `MORSE_UI_DIR` and friends. Passing
 * `process.env` straight to the PTY leaked them into every shell, so running
 * Morse from inside Morse picked the host's port and tried to bind it again
 * (`EADDRINUSE`). A shell here behaves as if opened from the user's desktop:
 * `MORSE_*` is stripped, and so is the IPC channel `fork`/`node --watch` puts in
 * the environment (a child Node would otherwise speak the parent's protocol).
 */
export function terminalShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('MORSE_') || key === 'NODE_CHANNEL_FD' || key === 'NODE_CHANNEL_SERIALIZATION_MODE') {
      continue;
    }
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  return env;
}

/**
 * One terminal the host is holding: the live shell (when it has one), the viewers
 * attached to it, and the scrollback.
 *
 * `output` is both the replay buffer and the on-disk log's in-memory copy: the
 * shell appends, a viewer that attaches late gets the whole bounded tail, and the
 * file is written on a debounce so a host restart still has it.
 */
interface TerminalEntry {
  pty?: IPty;
  sinks: Set<TerminalSink>;
  output: string;
  /** There is output the file has not seen yet. */
  dirty: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /**
   * Bumped whenever the shell is replaced or closed. A dead shell's late
   * callbacks compare it and stay silent, so they cannot append to (or report
   * over) the shell now holding the id.
   */
  generation: number;
}

/**
 * The browser host's terminal (driven adapter). A real pseudo-terminal via
 * `node-pty`, so the shell is interactive exactly as in a desktop terminal:
 * prompts, colours, line editing, resize and full-screen programs (vim, top)
 * all work.
 *
 * The process runs in the viewing session's directory and is gated by
 * `ProjectPolicy`, like opening a session. A directory the policy refuses throws
 * before anything is spawned.
 *
 * This class is a *registry*, not a per-connection spawner: it is a singleton, so
 * the shell and its scrollback outlive the connection that opened it. A reloaded
 * page attaches to the same process and catches up on `replay`; only an explicit
 * `close` (or the idle timeout) ends a shell. The scrollback also lands under
 * `<MORSE_HOME>/terminals/`, so the output survives the *host* restarting too.
 */
@Injectable()
export class ServerTerminalBackend implements TerminalBackend, OnModuleDestroy {
  private readonly entries = new Map<string, TerminalEntry>();

  constructor(
    @Inject(MORSE_PROJECT_POLICY) private readonly policy: ServerProjectPolicy,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
    @Inject(MORSE_CONFIG) private readonly config: MorseServerConfig,
  ) {}

  attach(
    terminalId: string,
    options: TerminalOpenOptions,
    sink: TerminalSink,
  ): TerminalSession {
    const entry = this.entryFor(terminalId);
    if (entry.pty === undefined) {
      // No live shell: either the first open ever, or one that exited / was
      // reclaimed. The log is already loaded, so a fresh shell continues the
      // history instead of starting blank.
      this.spawn(terminalId, entry, options);
    } else {
      // A live shell takes the reattaching viewer's size.
      this.resize(entry, options.cols, options.rows);
    }
    entry.sinks.add(sink);
    this.cancelIdle(entry);
    return {
      replay: entry.output,
      write: (data) => entry.pty?.write(data),
      resize: (cols, rows) => this.resize(entry, cols, rows),
      detach: () => this.detach(terminalId, entry, sink),
    };
  }

  /** Ends a shell for good, drops its scrollback, and tells any other viewer. */
  close(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    this.entries.delete(terminalId);
    if (entry !== undefined) {
      this.stopFlush(entry);
      this.cancelIdle(entry);
      entry.generation += 1;
      const sinks = [...entry.sinks];
      entry.sinks.clear();
      this.killPty(entry.pty);
      entry.pty = undefined;
      // A viewer in another window is looking at a shell that is now gone.
      for (const sink of sinks) {
        sink.exit();
      }
    }
    removeTerminalLog(this.config.dataDir, terminalId);
  }

  async onModuleDestroy(): Promise<void> {
    // The host is going away, so the shells cannot outlive it — but the
    // scrollback can. Signal first and let the shells finish their shutdown log
    // (a dev server prints its last lines only after SIGTERM), then persist: the
    // next start replays the file, shutdown messages included. `onExit` may
    // persist during the wait; the pass after it is a no-op unless new output
    // arrived.
    const entries = [...this.entries];
    for (const [, entry] of entries) {
      this.stopFlush(entry);
      this.cancelIdle(entry);
      this.killPty(entry.pty);
    }
    if (entries.some(([, entry]) => entry.pty !== undefined)) {
      await delay(SHUTDOWN_GRACE_MS);
    }
    for (const [terminalId, entry] of entries) {
      // Nothing should append after this: the shutdown is the last writer.
      entry.generation += 1;
      this.persist(terminalId, entry);
      this.killPty(entry.pty);
      entry.pty = undefined;
      this.stopFlush(entry);
      this.cancelIdle(entry);
    }
    this.entries.clear();
  }

  /** SIGTERM, then SIGKILL for a shell that ignores it (a hung process group). */
  private killPty(pty: IPty | undefined): void {
    if (pty === undefined) {
      return;
    }
    try {
      pty.kill();
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        pty.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, SIGKILL_AFTER_MS);
    timer.unref?.();
  }

  private entryFor(terminalId: string): TerminalEntry {
    const existing = this.entries.get(terminalId);
    if (existing !== undefined) {
      return existing;
    }
    const entry: TerminalEntry = {
      sinks: new Set(),
      output: readTerminalLog(this.config.dataDir, terminalId),
      dirty: false,
      generation: 0,
    };
    this.entries.set(terminalId, entry);
    return entry;
  }

  private spawn(terminalId: string, entry: TerminalEntry, options: TerminalOpenOptions): void {
    // The controller passes the session's directory, but the payload can name
    // its own: the policy is what decides, exactly like opening a session.
    if (!this.policy.canOpen(options.cwd)) {
      throw new UnsupportedByHostError(`Morse is not allowed to run a terminal in ${options.cwd}.`);
    }
    const shell = defaultShell();
    const generation = ++entry.generation;
    const pty = spawnPty(shell, [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: terminalShellEnv(),
    });
    entry.pty = pty;
    this.logger.info(`Terminal opened in ${options.cwd} (${shell}, pid ${pty.pid})`);

    pty.onData((chunk) => {
      if (entry.generation !== generation) {
        return;
      }
      // `+=` builds a rope cheaply; trimming every chunk would flatten (copy) the
      // whole buffer per chunk, which a command like `yes` would feel. Let it
      // overshoot, then cut back to the cap in one pass.
      entry.output += chunk;
      if (entry.output.length > TERMINAL_BUFFER_CHARS * 1.5) {
        entry.output = trimTail(entry.output, TERMINAL_BUFFER_CHARS);
      }
      entry.dirty = true;
      this.scheduleFlush(terminalId, entry);
      for (const sink of entry.sinks) {
        sink.output(chunk);
      }
    });
    pty.onExit(({ exitCode }) => {
      if (entry.generation !== generation) {
        return;
      }
      entry.pty = undefined;
      this.persist(terminalId, entry);
      for (const sink of [...entry.sinks]) {
        sink.exit(exitCode);
      }
    });
  }

  private resize(entry: TerminalEntry, cols: number, rows: number): void {
    try {
      entry.pty?.resize(cols, rows);
    } catch {
      // A shell that exited between the attach and the resize: nothing to size.
    }
  }

  private detach(terminalId: string, entry: TerminalEntry, sink: TerminalSink): void {
    entry.sinks.delete(sink);
    if (entry.sinks.size > 0) {
      return;
    }
    // Nobody is watching: write the scrollback down and start the idle clock.
    this.persist(terminalId, entry);
    this.scheduleIdle(terminalId, entry);
  }

  /**
   * Reclaims a shell nobody has reattached to. The log stays (the output should
   * still be there next time); only the process goes.
   */
  private scheduleIdle(terminalId: string, entry: TerminalEntry): void {
    if (this.config.terminalIdleMs <= 0) {
      return;
    }
    this.cancelIdle(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.sinks.size > 0) {
        return;
      }
      entry.generation += 1;
      this.killPty(entry.pty);
      entry.pty = undefined;
      this.persist(terminalId, entry);
      this.entries.delete(terminalId);
    }, this.config.terminalIdleMs);
    entry.idleTimer.unref?.();
  }

  private cancelIdle(entry: TerminalEntry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private scheduleFlush(terminalId: string, entry: TerminalEntry): void {
    if (entry.flushTimer !== undefined) {
      return;
    }
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = undefined;
      this.persist(terminalId, entry);
    }, FLUSH_DEBOUNCE_MS);
    entry.flushTimer.unref?.();
  }

  private stopFlush(entry: TerminalEntry): void {
    if (entry.flushTimer !== undefined) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = undefined;
    }
  }

  private persist(terminalId: string, entry: TerminalEntry): void {
    this.stopFlush(entry);
    if (!entry.dirty) {
      return;
    }
    entry.dirty = false;
    writeTerminalLog(this.config.dataDir, terminalId, entry.output);
  }
}

/** A beat for a shell's shutdown output to arrive before the buffer is frozen. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
