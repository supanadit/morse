import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Morse keeps its own data on this machine: the directory both hosts
 * (the server and the VS Code extension) use for the session index.
 *
 * One directory is the whole point: the index holds Morse-only state (a session
 * rename, the engine tokens reconcile skips on), and two hosts scanning the
 * same engine sessions must agree on it. This helper is the single source of
 * the location, so the hosts cannot drift apart again — the extension imports
 * it instead of naming its own path beside the server's.
 */
export function morseDataDir(env: { MORSE_HOME?: string | undefined } = process.env): string {
  const explicit = env.MORSE_HOME?.trim();
  return explicit !== undefined && explicit.length > 0 ? explicit : join(homedir(), '.morse');
}

/** The session index directory under Morse's data directory. */
export function morseSessionsDir(env: { MORSE_HOME?: string | undefined } = process.env): string {
  return join(morseDataDir(env), 'sessions');
}
