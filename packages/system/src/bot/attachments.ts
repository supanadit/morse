import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotFileInput } from '@morse/protocol';

/**
 * Files the reader attaches to a bot message, put where that bot can open them.
 *
 * A bot conversation is not a code session: it has no workspace picker, no
 * upload route and no file tree in the UI, and the browser still cannot hand a
 * dropped file's path to anything. So the bytes travel with the message and the
 * host writes them into the bot's **own** `workspace/uploads/` — the directory
 * that bot already runs in — and the prompt names the relative path. The bot
 * opens it with the tools it already has (`read`, `bash`), the file lives with
 * the bot it was sent to, and no bot ever sees another's attachments.
 *
 * Relative paths on purpose: each bot's cwd is its own workspace, so the same
 * `uploads/report.csv` means the right file for whichever bot was addressed.
 */

/** Keep in sync with the server's `MAX_UPLOAD_BYTES`. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Where attachments land inside a bot's workspace, relative to its cwd. */
const UPLOAD_DIR = 'uploads';

/** A name a path can hold, without losing what the file was called. */
const MAX_NAME_LENGTH = 80;

export interface WrittenAttachments {
  /** Workspace-relative paths (`uploads/report.csv`), in the order attached. */
  paths: string[];
  /** Names that could not be written, so the reader hears about them. */
  failed: string[];
}

/**
 * Writes every attachment into `<workspace>/uploads`, answering the paths the
 * prompt should name. A file that cannot be written (too large, a name that
 * leaves nothing usable, a base64 payload that is not base64) is reported by
 * name instead of failing the message: the reader's words still go out.
 */
export function writeBotAttachments(
  workspace: string,
  files: readonly BotFileInput[],
): WrittenAttachments {
  const written: WrittenAttachments = { paths: [], failed: [] };
  if (files.length === 0) {
    return written;
  }
  const dir = join(workspace, UPLOAD_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const taken = new Set<string>();
  for (const file of files) {
    const name = safeName(file.name);
    const bytes = decode(file.data);
    if (name === undefined || bytes === undefined || bytes.length > MAX_ATTACHMENT_BYTES) {
      written.failed.push(file.name);
      continue;
    }
    const unique = uniqueName(dir, name, taken);
    taken.add(unique);
    try {
      // Readable by the reader and the bot, never by anyone else on the box.
      writeFileSync(join(dir, unique), bytes, { mode: 0o600 });
      written.paths.push(`${UPLOAD_DIR}/${unique}`);
    } catch {
      written.failed.push(file.name);
    }
  }
  return written;
}

/**
 * The name a file keeps, reduced to what a path can carry: no directory
 * separators (an attachment is never a path instruction), no leading dot, and
 * short enough to stay readable in a prompt.
 */
function safeName(raw: string): string | undefined {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  // A name of only dots or separators says nothing about the file.
  if (cleaned === '' || /^[.\-_\s]+$/.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

/** `report.csv`, then `report-1.csv`, so two attachments never overwrite each other. */
function uniqueName(dir: string, name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let suffix = 1;
  while (taken.has(candidate) || existsSync(join(dir, candidate))) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

/** The payload as bytes, or nothing when it is not base64 at all. */
function decode(data: string): Buffer | undefined {
  if (data === '') {
    return undefined;
  }
  try {
    const bytes = Buffer.from(data, 'base64');
    return bytes.length === 0 ? undefined : bytes;
  } catch {
    return undefined;
  }
}
