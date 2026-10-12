import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionSpeed } from '@morse/core';

/**
 * Session-wide generation speed: what pi does not measure. pi reports token
 * counts but keeps no clock, so the adapter times each assistant message
 * (`message_start` → `message_end`) and accumulates the totals here, persisted
 * under the host's data directory so a resumed session continues its history
 * instead of starting back at zero.
 *
 * Files live at `<dataDir>/speed/<hash>.json`, one per pi session. A missing,
 * unreadable or foreign file is not an error — it just means "no speed yet".
 */

/** One subdirectory for all sessions, so a flat data dir stays readable. */
const SPEED_DIR = 'speed';
const FILE_VERSION = 1;
/**
 * A hand-written or truncated file would corrupt the totals it feeds; anything
 * larger than this is neither. Tiny — the whole record is six numbers.
 */
const MAX_BYTES = 16 * 1024;
/**
 * A message this short measures request latency, not generation speed: a
 * three-token "ok" behind 800 ms of network would otherwise pin the session's
 * "lowest" forever. The same counted set feeds the average, the peak and the
 * lowest, so the average can never fall outside the range the extremes show.
 */
export const MIN_SPEED_OUTPUT_TOKENS = 25;

/** The accumulator as it is persisted, one file per pi session. */
export interface StoredSessionSpeed {
  version: number;
  /** The session identity the file was written for (a pi session file path). */
  session: string;
  /** Σ output tokens of every counted message. */
  tokens: number;
  /** Σ seconds spent generating them. */
  seconds: number;
  /** How many messages were counted. */
  messages: number;
  peak?: number;
  slowest?: number;
}

/** A fresh accumulator for a session with no file yet. */
export function emptySpeed(session: string): StoredSessionSpeed {
  return { version: FILE_VERSION, session, tokens: 0, seconds: 0, messages: 0 };
}

/**
 * Folds one measured message into the accumulator, or returns `undefined` when
 * the message says nothing about speed (too few tokens, no elapsed time). The
 * caller only persists what comes back, so an uncounted message leaves the
 * stored file untouched.
 */
export function recordSpeed(
  prev: StoredSessionSpeed,
  outputTokens: number,
  durationMs: number,
): StoredSessionSpeed | undefined {
  if (!Number.isFinite(outputTokens) || outputTokens < MIN_SPEED_OUTPUT_TOKENS) {
    return undefined;
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }
  const rate = outputTokens / (durationMs / 1000);
  return {
    ...prev,
    tokens: prev.tokens + outputTokens,
    seconds: prev.seconds + durationMs / 1000,
    messages: prev.messages + 1,
    peak: prev.peak === undefined ? rate : Math.max(prev.peak, rate),
    slowest: prev.slowest === undefined ? rate : Math.min(prev.slowest, rate),
  };
}

/**
 * The accumulator as the panel shows it, or `undefined` when nothing has been
 * counted yet (a fresh or malformed file) — the UI reads that as `—`, not `0/s`.
 */
export function snapshotSpeed(stored: StoredSessionSpeed | undefined): SessionSpeed | undefined {
  if (
    stored === undefined ||
    stored.messages < 1 ||
    stored.seconds <= 0 ||
    stored.peak === undefined ||
    stored.slowest === undefined
  ) {
    return undefined;
  }
  return {
    avgTokensPerSecond: stored.tokens / stored.seconds,
    peakTokensPerSecond: stored.peak,
    slowestTokensPerSecond: stored.slowest,
  };
}

/** The file a session's accumulator is stored in (exported for tests). */
export function speedFile(dataDir: string, session: string): string {
  const hash = createHash('sha1').update(session).digest('hex').slice(0, 16);
  return join(dataDir, SPEED_DIR, `${hash}.json`);
}

/** Reads a session's accumulator; anything unreadable means "no speed yet". */
export async function loadSpeed(
  dataDir: string,
  session: string,
): Promise<StoredSessionSpeed | undefined> {
  let raw: string;
  try {
    raw = await readFile(speedFile(dataDir, session), 'utf8');
  } catch {
    return undefined;
  }
  if (raw.length > MAX_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return asStored(parsed, session);
}

/**
 * Writes an accumulator back, atomically (a temp file beside it, then a
 * rename), so a crash mid-write leaves the previous totals intact rather than
 * a truncated file. Best-effort: speed is a nicety, never a reason to fail a
 * message.
 */
export async function saveSpeed(dataDir: string, stored: StoredSessionSpeed): Promise<void> {
  const serialized = JSON.stringify(stored);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
    return;
  }
  const target = speedFile(dataDir, stored.session);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(join(dataDir, SPEED_DIR), { recursive: true });
    await writeFile(temp, serialized);
    await rename(temp, target);
  } catch {
    // Some filesystems refuse a rename over an existing file (a Windows mount).
    try {
      await writeFile(target, serialized);
    } catch {
      await rm(temp, { force: true });
    }
  }
}

/** The file contents, with anything that is not this session's record dropped. */
function asStored(value: unknown, session: string): StoredSessionSpeed | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== FILE_VERSION || candidate['session'] !== session) {
    return undefined;
  }
  const tokens = candidate['tokens'];
  const seconds = candidate['seconds'];
  const messages = candidate['messages'];
  if (
    typeof tokens !== 'number' ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    typeof messages !== 'number' ||
    !Number.isFinite(messages) ||
    messages < 0
  ) {
    return undefined;
  }
  const peak = candidate['peak'];
  const slowest = candidate['slowest'];
  return {
    version: FILE_VERSION,
    session,
    tokens,
    seconds,
    messages,
    ...(typeof peak === 'number' && Number.isFinite(peak) ? { peak } : {}),
    ...(typeof slowest === 'number' && Number.isFinite(slowest) ? { slowest } : {}),
  };
}
