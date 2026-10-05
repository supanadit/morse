import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL_BUFFER_CHARS, trimTail } from '@morse/host-runtime';

/** The directory under `<MORSE_HOME>` holding one scrollback file per terminal. */
const LOG_DIR = 'terminals';
/**
 * How much scrollback a terminal keeps across a host restart. Larger than the
 * in-memory replay because the file is the long-term copy: a reader who comes
 * back the next day still finds what they were looking at.
 */
const LOG_MAX_CHARS = TERMINAL_BUFFER_CHARS * 4;

/**
 * The scrollback a shell produced, kept on disk under `<MORSE_HOME>/terminals/`.
 *
 * This is what makes a terminal's *output* survive the host itself: the live
 * buffer lives in memory and is lost on a restart, so the file is written as the
 * shell streams (debounced by the caller) and read back the next time a pane
 * with the same id attaches. A missing or unreadable file is not an error — it
 * just means there is nothing to replay.
 */
export function readTerminalLog(dataDir: string, terminalId: string): string {
  try {
    const raw = readFileSync(logPath(dataDir, terminalId), 'utf8');
    return trimTail(raw, LOG_MAX_CHARS);
  } catch {
    return '';
  }
}

/** Writes the current scrollback, capped and trimmed to the tail. Atomic, so a crash cannot truncate it. */
export function writeTerminalLog(dataDir: string, terminalId: string, text: string): void {
  const trimmed = trimTail(text, LOG_MAX_CHARS);
  const target = logPath(dataDir, terminalId);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(join(dataDir, LOG_DIR), { recursive: true });
    writeFileSync(temp, trimmed);
    renameSync(temp, target);
  } catch {
    // Some filesystems refuse a rename over an existing file (a Windows mount).
    try {
      writeFileSync(target, trimmed);
    } catch {
      rmSync(temp, { force: true });
    }
  }
}

/** Forgets a terminal's scrollback (the reader closed the pane). */
export function removeTerminalLog(dataDir: string, terminalId: string): void {
  rmSync(logPath(dataDir, terminalId), { force: true });
}

/**
 * A terminal id the client named, turned into a filename. An id is not trusted:
 * a `../` in it must not become a path, so anything outside a conservative set
 * is replaced. The frontend mints `term-N`, which passes through untouched.
 */
export function safeTerminalName(terminalId: string): string {
  const safe = terminalId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return safe.length > 0 ? safe : 'terminal';
}

function logPath(dataDir: string, terminalId: string): string {
  return join(dataDir, LOG_DIR, `${safeTerminalName(terminalId)}.log`);
}
