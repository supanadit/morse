/**
 * Atomic config writes: the bytes land in a sibling temp file and are renamed
 * over the target, so a crash leaves either the old file or the new one — never
 * a half-written config. Isolated files (a bot's own tree) are private from the
 * moment they exist; a user file keeps whatever mode it already had.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { WritePolicy } from './types.js';

export function writeAtomic(path: string, text: string, policy: WritePolicy): void {
  // `mode` only applies when the directory is created; an existing one keeps its mode.
  mkdirSync(dirname(path), { recursive: true, mode: policy.dirMode ?? 0o700 });
  const mode = fileModeFor(path, policy);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    // The process umask can strip bits `writeFileSync` asked for; the mode is a contract.
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A fingerprint a watcher can poll: the size and mtime, or `'-'` when absent. */
export function fileSignature(path: string): string {
  try {
    const info = statSync(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return '-';
  }
}

function fileModeFor(path: string, policy: WritePolicy): number {
  if (policy.fileMode !== undefined) {
    return policy.fileMode;
  }
  if (policy.ownership === 'isolated') {
    return 0o600;
  }
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
}
