import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

/**
 * A browser cannot hand the agent a dragged file's path, so it sends the bytes
 * instead and the host — which owns a disk next to the session — writes them
 * down and answers with a path the frontend can `@mention`.
 *
 * Files land under the session's own directory by default, so pi's `read` (and
 * `grep`/`find`) resolve the mention exactly like any other workspace file.
 */

/** Refuse anything larger: base64 of a huge file would also bloat the socket. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Default inbox, relative to the session cwd; `MORSE_UPLOAD_DIR` overrides it. */
export const DEFAULT_UPLOAD_DIR = '.morse/uploads';

export interface SavedUpload {
  /** Path for the `@mention`: cwd-relative when it lives under the cwd. */
  path: string;
  /** The name the file was actually stored under (deduplicated). */
  name: string;
  bytes: number;
}

/** A rejected upload; the message is shown to the user, so it says what to fix. */
export class UploadError extends Error {}

export async function saveUpload(
  cwd: string,
  request: Record<string, unknown>,
  uploadDir: string = DEFAULT_UPLOAD_DIR,
): Promise<SavedUpload> {
  const name = safeFileName(request.name);
  const data = request.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new UploadError('That upload carried no data.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) {
    throw new UploadError('That upload carried no data.');
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `That file is ${formatMb(bytes.length)} MB; the limit is ${formatMb(MAX_UPLOAD_BYTES)} MB.`,
    );
  }

  const directory = isAbsolute(uploadDir) ? uploadDir : join(cwd, uploadDir);
  await mkdir(directory, { recursive: true });
  const target = uniquePath(directory, name);
  await writeFile(target, bytes);

  return { path: mentionPath(cwd, target), name: basename(target), bytes: bytes.length };
}

/**
 * Keeps only the last path segment and strips what a filesystem rejects, so a
 * hostile client cannot escape the inbox with `../../etc/passwd`.
 */
export function safeFileName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  const base = basename(value.replace(/\\/g, '/')).trim();
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned.length === 0) {
    throw new UploadError('That upload had no usable file name.');
  }
  return cleaned.slice(0, 120);
}

/** `report.pdf` -> `report-1.pdf` when the first name is taken. */
function uniquePath(directory: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = join(directory, name);
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = join(directory, `${stem}-${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
}

function mentionPath(cwd: string, target: string): string {
  const rel = relative(cwd, target);
  const posix = rel.split(sep).join('/');
  // An absolute `MORSE_UPLOAD_DIR` may point outside the cwd; then the mention
  // has to be absolute, because there is no relative form that resolves.
  return posix.length === 0 || posix.startsWith('..') || isAbsolute(rel) ? target : posix;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}
