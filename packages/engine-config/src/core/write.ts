/**
 * Atomic config writes: the bytes land in a sibling temp file and are renamed
 * over the target, so a crash leaves either the old file or the new one — never
 * a half-written config. Isolated files (a bot's own tree) are private from the
 * moment they exist; a user file keeps whatever mode it already had.
 *
 * A symlinked config — the common dotfiles setup (`opencode.json` in
 * `~/.config` pointing into a repository) — is written **through** the link:
 * the temp file and the rename happen in the resolved target's directory, so
 * the link survives and only its target changes. Renaming over the link itself
 * would replace it with a regular file and silently break the dotfiles repo.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { WritePolicy } from './types.js';

export function writeAtomic(path: string, text: string, policy: WritePolicy): void {
  const target = resolvedWriteTarget(path);
  // `mode` only applies when the directory is created; an existing one keeps its mode.
  mkdirSync(dirname(target), { recursive: true, mode: policy.dirMode ?? 0o700 });
  const mode = fileModeFor(target, policy);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    // The process umask can strip bits `writeFileSync` asked for; the mode is a contract.
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * The file the bytes actually belong in: `path` itself, or the file a symlink
 * at `path` resolves to. A dangling link still names its target (relative links
 * resolve against the link's directory), so writing one repairs the target
 * instead of replacing the link with a regular file.
 */
function resolvedWriteTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      return path;
    }
  } catch {
    // Absent: nothing to resolve.
    return path;
  }
  try {
    return realpathSync(path);
  } catch {
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      // A link that cannot be read is reported by the write below.
      return path;
    }
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
