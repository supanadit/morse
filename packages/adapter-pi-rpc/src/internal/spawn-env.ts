/**
 * The environment an external `pi` process should inherit.
 *
 * `node --watch` (and any process started with `fork`) puts an IPC channel into
 * the environment as `NODE_CHANNEL_FD` + `NODE_CHANNEL_SERIALIZATION_MODE`. A
 * child that inherits them tries to speak the parent's IPC protocol instead of
 * running as a plain process and dies with `write EINVAL` before it can do
 * anything. Node strips those variables for `fork`, but a plain `spawn` or
 * `execFile` does not, and both the RPC session and `pi mcp` run through those.
 *
 * Everything else — `PATH`, `HOME`, `PI_CODING_AGENT_DIR`, credentials — is left
 * untouched, so pi behaves exactly as it does from a shell.
 */
export function cleanSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy.NODE_CHANNEL_FD;
  delete copy.NODE_CHANNEL_SERIALIZATION_MODE;
  return copy;
}
