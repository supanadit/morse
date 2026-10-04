import { open, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { UnsupportedByHostError } from '@morse/core';

/**
 * How much of a file a preview reads. A 40 MB bundle in a text view is not a
 * preview; the response says it was cut short so the frontend can tell the user.
 */
const MAX_PREVIEW_BYTES = 512 * 1024;

/** How much of a file is sniffed for NUL bytes: a file is binary or it is not near the top. */
const SNIFF_BYTES = 8 * 1024;

/** What the frontend needs to draw a file: its text, size and whether it was cut. */
export interface WorkspaceFilePreview {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  /** A binary file has no useful text; `content` is empty and the UI says so. */
  binary: boolean;
}

/**
 * Reads one file for the frontend's preview tab. The path is resolved against
 * the project the client is viewing and must stay inside it: the browser host
 * never opens a path the client names outside the session's directory (which
 * `ProjectPolicy` already approved when the session was opened).
 */
export async function readWorkspaceFile(
  cwd: string,
  requested: string,
): Promise<WorkspaceFilePreview> {
  const target = resolveWithin(cwd, requested);
  const info = await stat(target).catch(() => undefined);
  if (info === undefined) {
    throw new UnsupportedByHostError(`No such file: ${requested}`);
  }
  if (info.isDirectory()) {
    throw new UnsupportedByHostError(`${requested} is a directory, not a file.`);
  }
  const handle = await open(target, 'r');
  try {
    const length = Math.min(info.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const slice = buffer.subarray(0, bytesRead);
    const binary = slice.subarray(0, Math.min(bytesRead, SNIFF_BYTES)).includes(0);
    return {
      path: toPosix(relative(cwd, target)),
      content: binary ? '' : slice.toString('utf8'),
      size: info.size,
      truncated: info.size > bytesRead,
      binary,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Resolves a client path under `cwd` and refuses anything that escapes it. An
 * absolute path is a client naming a file the session does not own, so it is
 * rejected rather than silently reinterpreted.
 */
export function resolveWithin(cwd: string, requested: string): string {
  if (isAbsolute(requested)) {
    throw new UnsupportedByHostError('A preview only opens files inside the project.');
  }
  const target = resolve(cwd, requested);
  const rel = relative(cwd, target);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UnsupportedByHostError('A preview only opens files inside the project.');
  }
  return target;
}

/** Preview paths read with `/` on every platform, the way pi prints them. */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}
