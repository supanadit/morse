import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { SessionCatalog, SessionSummary } from '@morse/core';
import { asRecord, asString } from './internal/rpc-types.js';
import { resolveSessionDir } from './internal/resolve-pi.js';

export interface PiRpcSessionCatalogOptions {
  sessionDir?: string;
  maxSessions?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * How one session file is removed. Defaults to `unlink`; a host can inject its
   * own (VS Code goes through the workspace filesystem, so the file lands in the
   * OS trash and the call works in remote windows too).
   */
  removeFile?: (path: string) => Promise<void>;
}

/**
 * Implements `SessionCatalog` by reading pi's session files
 * (`<session-dir>/--<cwd>--/<timestamp>_<id>.jsonl`, see docs/session-format.md).
 * The id returned is the session file path so it can be resumed with
 * `pi --session <path>`.
 */
export class PiRpcSessionCatalog implements SessionCatalog {
  private readonly directory: string;
  private readonly maxSessions: number;
  private readonly removeFile: (path: string) => Promise<void>;

  constructor(options: PiRpcSessionCatalogOptions = {}) {
    this.directory = resolveSessionDir(options.sessionDir, options.env);
    this.maxSessions = options.maxSessions ?? 50;
    this.removeFile = options.removeFile ?? unlink;
  }

  get sessionDirectory(): string {
    return this.directory;
  }

  async list(): Promise<SessionSummary[]> {
    const files = await this.collectSessionFiles();
    const summaries: SessionSummary[] = [];
    for (const file of files.slice(0, this.maxSessions)) {
      const summary = await readSessionSummary(file.path, file.updatedAt);
      if (summary) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  /**
   * Deletes one stored session. The id is a session file path, so the guard is
   * the point: only a `.jsonl` inside this catalog's session directory is ever
   * removed. A stale client or a hostile payload cannot turn a session id into
   * a delete of an arbitrary file.
   */
  async remove(id: string): Promise<void> {
    const path = resolve(id);
    const directory = resolve(this.directory);
    if (!path.startsWith(`${directory}${sep}`) || !path.endsWith('.jsonl')) {
      throw new Error(`Refusing to delete a session outside ${directory}`);
    }
    await this.removeFile(path);
  }

  private async collectSessionFiles(): Promise<{ path: string; updatedAt: number }[]> {
    const buckets = await safeReadDir(this.directory);
    const files: { path: string; updatedAt: number }[] = [];
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) {
        continue;
      }
      const bucketPath = join(this.directory, bucket.name);
      for (const entry of await safeReadDir(bucketPath)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        const path = join(bucketPath, entry.name);
        const info = await stat(path).catch(() => undefined);
        files.push({ path, updatedAt: info?.mtimeMs ?? 0 });
      }
    }
    files.sort((left, right) => right.updatedAt - left.updatedAt);
    return files;
  }
}

async function readSessionSummary(
  path: string,
  updatedAt: number,
): Promise<SessionSummary | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    return undefined;
  }

  let id = basename(path, '.jsonl');
  let cwd = '';
  let name: string | undefined;
  let firstUserText: string | undefined;
  let messageCount = 0;

  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry['type'];
    if (type === 'session' && cwd.length === 0) {
      id = asString(entry['id']) ?? id;
      cwd = asString(entry['cwd']) ?? '';
      continue;
    }
    if (type === 'message') {
      messageCount += 1;
      if (!firstUserText) {
        const message = asRecord(entry['message']);
        if (message?.['role'] === 'user') {
          firstUserText = textOf(message['content']);
        }
      }
      continue;
    }
    if ((type === 'session_info' || type === 'session_name') && !name) {
      name = asString(entry['name']);
    }
  }

  return {
    id: path,
    title: name ?? titleFromText(firstUserText) ?? 'Untitled session',
    cwd,
    updatedAt,
    messageCount,
  };
}

/**
 * User content is either a plain string or a list of blocks; only text blocks
 * carry a title-worth string (images and tool results do not).
 */
function textOf(content: unknown): string | undefined {
  const direct = asString(content);
  if (direct !== undefined) {
    return direct.length > 0 ? direct : undefined;
  }
  const blocks = Array.isArray(content) ? content : undefined;
  if (!blocks) {
    return undefined;
  }
  for (const block of blocks) {
    const record = asRecord(block);
    if (record?.['type'] !== 'text') {
      continue;
    }
    const text = asString(record['text']);
    if (text !== undefined && text.trim().length > 0) {
      return text;
    }
  }
  return undefined;
}

function titleFromText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length === 0) {
    return undefined;
  }
  return single.length > 72 ? `${single.slice(0, 72)}…` : single;
}

async function safeReadDir(path: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
