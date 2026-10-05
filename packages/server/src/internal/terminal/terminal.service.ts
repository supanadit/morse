import { spawn as spawnPty } from 'node-pty';
import { Inject, Injectable } from '@nestjs/common';
import { UnsupportedByHostError, type MorseLogger } from '@morse/core';
import type {
  TerminalBackend,
  TerminalOpenOptions,
  TerminalProcess,
  TerminalSink,
} from '@morse/host-runtime';
import { MORSE_LOGGER, MORSE_PROJECT_POLICY } from '../../app/tokens.js';
import type { ServerProjectPolicy } from '../projects/project-policy.js';

/** How long a shell gets to exit on kill before it is killed outright. */
const SIGKILL_AFTER_MS = 1_500;

/** The user's shell, falling back per platform when `$SHELL` is not set. */
function defaultShell(): string {
  const configured = process.env.SHELL?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
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
 */
@Injectable()
export class ServerTerminalBackend implements TerminalBackend {
  constructor(
    @Inject(MORSE_PROJECT_POLICY) private readonly policy: ServerProjectPolicy,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
  ) {}

  open(options: TerminalOpenOptions, sink: TerminalSink): TerminalProcess {
    // The controller passes the session's directory, but the payload can name
    // its own: the policy is what decides, exactly like opening a session.
    if (!this.policy.canOpen(options.cwd)) {
      throw new UnsupportedByHostError(
        `Morse is not allowed to run a terminal in ${options.cwd}.`,
      );
    }
    const shell = defaultShell();
    const pty = spawnPty(shell, [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: { ...process.env, TERM: 'xterm-256color', MORSE_TERMINAL: '1' },
    });
    this.logger.info(`Terminal opened in ${options.cwd} (${shell}, pid ${pty.pid})`);

    let exited = false;
    const data = pty.onData((chunk) => sink.output(chunk));
    pty.onExit(({ exitCode }) => {
      exited = true;
      data.dispose();
      sink.exit(exitCode);
    });

    return {
      write: (input) => {
        if (!exited) {
          pty.write(input);
        }
      },
      resize: (cols, rows) => {
        if (!exited) {
          pty.resize(cols, rows);
        }
      },
      kill: () => {
        if (exited) {
          return;
        }
        exited = true;
        pty.kill();
        // A shell that ignored SIGTERM (a hung process group) still goes.
        const timer = setTimeout(() => pty.kill('SIGKILL'), SIGKILL_AFTER_MS);
        timer.unref?.();
      },
    };
  }
}
