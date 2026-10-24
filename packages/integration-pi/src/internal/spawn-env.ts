/**
 * The environment an external `pi` process should inherit.
 *
 * Two families of variables are stripped, both of which make a freshly spawned
 * `pi` misbehave:
 *
 * 1. `node --watch` (and anything started with `fork`) puts an IPC channel into
 *    the environment as `NODE_CHANNEL_FD` + `NODE_CHANNEL_SERIALIZATION_MODE`.
 *    A child that inherits them tries to speak the parent's IPC protocol instead
 *    of running as a plain process and dies with `write EINVAL` before it can do
 *    anything. Node strips those variables for `fork`, but a plain `spawn` or
 *    `execFile` does not, and both the RPC session and `pi mcp` run through
 *    those.
 *
 * 2. `PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` /
 *    `PI_REASONING_LEVEL` describe *the session that launched Morse* when Morse
 *    itself was started from inside pi (or a shell pi exported them into). A
 *    spawned pi would inherit that session identity instead of starting the one
 *    it was asked for. pi scrubs exactly this set for its own bash children
 *    (`resolveSpawnContext`), so Morse mirrors that list rather than inventing a
 *    rule of its own.
 *
 * Everything else — `PATH`, `HOME`, `PI_CODING_AGENT_DIR`, credentials — is left
 * untouched, so pi behaves exactly as it does from a shell. `PI_*` variables
 * that are *configuration* (the agent dir, a configured path) are deliberately
 * kept: they are set by the user for every pi, not carried by one session.
 */

/** Session-scoped variables pi itself strips before spawning a child. */
const SESSION_ENV_KEYS = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
] as const;

/** IPC-channel variables a `node` parent leaks; a spawned child must not see them. */
const IPC_ENV_KEYS = ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'] as const;

export function cleanSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of IPC_ENV_KEYS) {
    delete copy[key];
  }
  for (const key of SESSION_ENV_KEYS) {
    delete copy[key];
  }
  return copy;
}
