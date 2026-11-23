import { createRequire } from 'node:module';
import { UnsupportedByHostError } from '@morse/system';
import type { IPty } from '@lydell/node-pty';

type Spawn = (typeof import('@lydell/node-pty'))['spawn'];

/**
 * The terminal is optional. A platform without a prebuilt PTY, or a Node ABI the
 * prebuild does not cover, must not stop the rest of the host from starting: the
 * composition root uses `ptyAvailable` to leave the backend out, and the client
 * hides the bottom panel when the capability is off.
 */
let spawn: Spawn | undefined;
try {
  spawn = (createRequire(import.meta.url)('@lydell/node-pty') as { spawn: Spawn }).spawn;
} catch {
  // No native terminal on this host.
}

export const ptyAvailable = spawn !== undefined;

/** Spawns a shell, or reports that this host has no terminal. */
export function spawnPty(...args: Parameters<Spawn>): IPty {
  if (spawn === undefined) {
    throw new UnsupportedByHostError('This host has no terminal.');
  }
  return spawn(...args);
}

export type { IPty };
