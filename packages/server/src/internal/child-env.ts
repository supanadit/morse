/**
 * The environment a process Morse spawns should see: the user's own, with
 * Morse's variables removed.
 *
 * The server is a child of `morse start` (or `npm run dev`) and inherits
 * `MORSE_PORT`, `MORSE_WORKSPACE`, `MORSE_UI_DIR` and friends. Handing
 * `process.env` straight to a child leaked them into every shell, so running
 * Morse from inside Morse picked the host's port and tried to bind it again
 * (`EADDRINUSE`). A shell here behaves as if opened from the user's desktop:
 * `MORSE_*` is stripped, and so is the IPC channel `fork`/`node --watch` puts in
 * the environment (a child Node would otherwise speak the parent's protocol).
 *
 * The language servers get the same treatment for the same reason: `npx` and the
 * servers it runs are Node programs too, and one started under `node --watch`
 * would inherit `NODE_CHANNEL_FD` and try to talk to the host's supervisor.
 */
export function childProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      key.startsWith('MORSE_') ||
      key === 'NODE_CHANNEL_FD' ||
      key === 'NODE_CHANNEL_SERIALIZATION_MODE'
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}
