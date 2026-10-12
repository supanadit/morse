import { open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { SessionCatalog, SessionPage, SessionSummary } from '@morse/core';
import { DEFAULT_SESSIONS_PER_PROJECT } from '@morse/core';
import { asRecord, asString } from './internal/rpc-types.js';
import { resolveSessionDir } from './internal/resolve-pi.js';

export interface PiRpcSessionCatalogOptions {
  sessionDir?: string;
  /**
   * Sessions kept per project in the first list. Every project is still listed;
   * only its sessions are capped, and `listPage` fetches the rest. Defaults to
   * `DEFAULT_SESSIONS_PER_PROJECT`.
   */
  maxSessionsPerProject?: number;
  /**
   * @deprecated A single global cap is what made whole projects disappear from
   * the sidebar: `collectSessionFiles` sorts every project's files together, so
   * the newest 50 could all belong to one project and the others vanished. Kept
   * only so an old caller passing it still compiles; it is now a hard ceiling on
   * the *whole* list, applied after the per-project cap, and defaults to
   * unlimited.
   */
  maxSessions?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * How one session file is removed. Defaults to `unlink`; a host can inject its
   * own (VS Code goes through the workspace filesystem, so the file lands in the
   * OS trash and the call works in remote windows too).
   */
  removeFile?: (path: string) => Promise<void>;
  /**
   * How a session file is summarised. Defaults to reading it; a test injects its
   * own to see *when* a file is read at all (the cache below is the point).
   */
  readSummary?: (
    path: string,
    updatedAt: number,
    previous?: CachedSummary,
  ) => Promise<SessionScan | undefined>;
}

/** What reading one session file produced, plus where to resume next time. */
export interface SessionScan {
  summary: SessionSummary;
  scanned: number;
  name?: string;
  firstUserText?: string;
}

/** A summary plus everything needed to continue reading the file where it stopped. */
interface CachedSummary {
  size: number;
  updatedAt: number;
  summary: SessionSummary;
  /** Byte offset already scanned, always just past a newline. */
  scanned: number;
  /** Title sources found so far, kept apart from the rendered title. */
  name?: string;
  firstUserText?: string;
}

/**
 * pi writes one compact JSON object per line with `type` first. Reading a line's
 * type is therefore a couple of string searches, with no object to allocate and
 * no parse: reading a project's sessions means scanning tens of megabytes, and
 * `JSON.parse` on every line whose only contribution was bumping `messageCount`
 * cost ~0.6 s of CPU per `session/list` on a real catalog. A line that is *not*
 * in that shape is parsed the slow way, so nothing is silently missed.
 */
const TYPE_PREFIX = '{"type":"';

function typeAt(raw: string, start: number, end: number): string | undefined {
  if (!raw.startsWith(TYPE_PREFIX, start)) {
    return undefined;
  }
  const close = raw.indexOf('"', start + TYPE_PREFIX.length);
  return close === -1 || close > end ? undefined : raw.slice(start + TYPE_PREFIX.length, close);
}

/**
 * Implements `SessionCatalog` by reading pi's session files
 * (`<session-dir>/--<cwd>--/<timestamp>_<id>.jsonl`, see docs/session-format.md).
 * The id returned is the session file path so it can be resumed with
 * `pi --session <path>`.
 */
export class PiRpcSessionCatalog implements SessionCatalog {
  private readonly directory: string;
  private readonly maxSessionsPerProject: number;
  private readonly maxSessions: number;
  private readonly removeFile: (path: string) => Promise<void>;
  private readonly readSummary: (
    path: string,
    updatedAt: number,
    previous?: CachedSummary,
  ) => Promise<SessionScan | undefined>;
  /**
   * Summaries survive between calls, keyed by path and validated by size + mtime.
   * The list is asked for far more often than sessions change — every reconnect,
   * every new session, every rename — and re-reading every transcript each time
   * was the single most expensive thing the host did.
   */
  private readonly cache = new Map<string, CachedSummary>();
  /**
   * The cwd each bucket directory holds, learned from a summary we have read.
   * pi names a bucket `--<cwd with separators replaced>--`, which is lossy, so
   * the only trustworthy mapping is the one a session's own header gives us.
   */
  private readonly bucketCwd = new Map<string, string>();

  constructor(options: PiRpcSessionCatalogOptions = {}) {
    this.directory = resolveSessionDir(options.sessionDir, options.env);
    this.maxSessionsPerProject = Math.max(1, options.maxSessionsPerProject ?? DEFAULT_SESSIONS_PER_PROJECT);
    // Unlimited unless a caller explicitly asks for a ceiling: a global cap is
    // what used to drop whole projects, so it must never bite by default.
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    this.removeFile = options.removeFile ?? unlink;
    this.readSummary = options.readSummary ?? readSessionSummary;
  }

  get sessionDirectory(): string {
    return this.directory;
  }

  /**
   * A list already being built is handed to every caller instead of being started
   * again: two frontends connecting at the same moment, or a refresh landing while
   * a push is in flight, used to mean two full scans of the whole catalog.
   */
  private inFlight: Promise<SessionSummary[]> | undefined;

  async list(): Promise<SessionSummary[]> {
    this.inFlight ??= this.buildList().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * Every project's first page. The files are grouped by bucket first, so each
   * project contributes at most `maxSessionsPerProject` newest sessions — the
   * newest 50 *overall* is what let one busy project crowd every other project
   * out of the sidebar entirely.
   */
  private async buildList(): Promise<SessionSummary[]> {
    const files = await this.collectSessionFiles();
    const byBucket = groupByBucket(files);
    const summaries: SessionSummary[] = [];
    for (const [bucket, bucketFiles] of byBucket) {
      for (const file of bucketFiles.slice(0, this.maxSessionsPerProject)) {
        const summary = await this.readOne(file, bucket);
        if (summary !== undefined) {
          summaries.push(summary);
        }
      }
    }
    this.evictStaleCache(files);
    summaries.sort((left, right) => right.updatedAt - left.updatedAt);
    return summaries.slice(0, this.maxSessions);
  }

  /**
   * More of one project's sessions, newest first. The sidebar calls this behind
   * its "Load more" row, so a project with hundreds of sessions is read a page
   * at a time instead of all at once on first paint.
   */
  async listPage(options: { cwd: string; offset?: number; limit?: number }): Promise<SessionPage> {
    const files = await this.collectSessionFiles();
    const bucket = await this.bucketForCwd(options.cwd, files);
    const bucketFiles = bucket === undefined ? [] : (groupByBucket(files).get(bucket) ?? []);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(0, options.limit ?? this.maxSessionsPerProject);
    const page = bucketFiles.slice(offset, offset + limit);
    const sessions: SessionSummary[] = [];
    for (const file of page) {
      // `page` is empty when the bucket is unknown, so `bucket` is always set here.
      const summary = await this.readOne(file, bucket ?? file.bucket);
      if (summary !== undefined) {
        sessions.push(summary);
      }
    }
    return { sessions, hasMore: offset + limit < bucketFiles.length };
  }

  /**
   * True number of sessions per project, taken from the directory listing rather
   * than from the capped pages. The sidebar shows this count and a "Load more"
   * row only when it is larger than what has been shown, so it has to be the real
   * total even though the list itself is paged.
   */
  async countByProject(): Promise<Map<string, number>> {
    const files = await this.collectSessionFiles();
    const counts = new Map<string, number>();
    for (const [bucket, bucketFiles] of groupByBucket(files)) {
      const cwd = await this.cwdOfBucket(bucket, bucketFiles);
      if (cwd !== undefined) {
        counts.set(cwd, bucketFiles.length);
      }
    }
    return counts;
  }

  /** Reads one file into its summary, updating the cache and the bucket→cwd map. */
  private async readOne(
    file: SessionFile,
    bucket: string,
  ): Promise<SessionSummary | undefined> {
    const cached = this.cache.get(file.path);
    if (cached !== undefined && cached.size === file.size && cached.updatedAt === file.updatedAt) {
      this.rememberBucket(bucket, cached.summary.cwd);
      return cached.summary;
    }
    const scan = await this.readSummary(file.path, file.updatedAt, cached);
    if (scan === undefined) {
      this.cache.delete(file.path);
      return undefined;
    }
    this.cache.set(file.path, { size: file.size, updatedAt: file.updatedAt, ...scan });
    this.rememberBucket(bucket, scan.summary.cwd);
    return scan.summary;
  }

  private rememberBucket(bucket: string, cwd: string): void {
    if (cwd.length > 0 && !this.bucketCwd.has(bucket)) {
      this.bucketCwd.set(bucket, cwd);
    }
  }

  /**
   * The bucket directory holding a project's sessions. Answered from the learned
   * map when possible; otherwise one session header per unknown bucket is read to
   * learn its cwd, which is cheap at a few dozen buckets.
   */
  private async bucketForCwd(cwd: string, files: SessionFile[]): Promise<string | undefined> {
    for (const [bucket, known] of this.bucketCwd) {
      if (known === cwd) {
        return bucket;
      }
    }
    for (const [bucket, bucketFiles] of groupByBucket(files)) {
      if (await this.cwdOfBucket(bucket, bucketFiles) === cwd) {
        return bucket;
      }
    }
    return undefined;
  }

  /** The cwd a bucket holds, learned from its newest readable session. */
  private async cwdOfBucket(bucket: string, bucketFiles: SessionFile[]): Promise<string | undefined> {
    const known = this.bucketCwd.get(bucket);
    if (known !== undefined) {
      return known;
    }
    for (const file of bucketFiles) {
      const summary = await this.readOne(file, bucket);
      if (summary !== undefined && summary.cwd.length > 0) {
        return summary.cwd;
      }
    }
    return undefined;
  }

  /**
   * Drops summaries whose file is gone. The full file set is known from the
   * directory listing, so an entry is only evicted when its session no longer
   * exists — not when it merely fell outside a page, which is what evicting by
   * `maxSessions` used to do. `listPage` and `countByProject` only warm the
   * cache, so this runs from `list()` (and from whichever of them ran first on a
   * cold catalog, since a page read also primes the map).
   */
  private evictStaleCache(files: readonly SessionFile[]): void {
    const present = new Set(files.map((file) => file.path));
    for (const path of [...this.cache.keys()]) {
      if (!present.has(path)) {
        this.cache.delete(path);
      }
    }
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
    try {
      await this.removeFile(path);
    } catch (error: unknown) {
      // Already gone is what the caller asked for. A session file removed out
      // of band (or by a concurrent delete) must not turn "Delete" into an
      // error, so a not-found is a success — anything else still surfaces.
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  private async collectSessionFiles(): Promise<SessionFile[]> {
    const buckets = await safeReadDir(this.directory);
    const files: SessionFile[] = [];
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
        files.push({ path, size: info?.size ?? 0, updatedAt: info?.mtimeMs ?? 0, bucket: bucket.name });
      }
    }
    files.sort((left, right) => right.updatedAt - left.updatedAt);
    return files;
  }
}

/** One session file on disk, tagged with the bucket directory it sits in. */
interface SessionFile {
  path: string;
  size: number;
  updatedAt: number;
  bucket: string;
}

/**
 * Sessions split by project bucket, each bucket's files keeping the newest-first
 * order the full sort gave them. A `Map` preserves insertion order, so the
 * buckets come out in the order their newest session was touched too.
 */
function groupByBucket(files: readonly SessionFile[]): Map<string, SessionFile[]> {
  const byBucket = new Map<string, SessionFile[]>();
  for (const file of files) {
    const bucket = byBucket.get(file.bucket);
    if (bucket === undefined) {
      byBucket.set(file.bucket, [file]);
    } else {
      bucket.push(file);
    }
  }
  return byBucket;
}

/**
 * Reads one session file into a summary.
 *
 * A file that only *grew* since the last scan is read from where that scan
 * stopped: a long session appends a message at a time, and re-reading all 18 MB of
 * it for every `session/list` cost ~65 ms against ~1 ms for the tail. Anything else
 * — a shorter file, an older mtime, no previous scan — is read whole, so the
 * summary can never drift from the file.
 */
async function readSessionSummary(
  path: string,
  updatedAt: number,
  previous?: CachedSummary,
): Promise<SessionScan | undefined> {
  let resumable =
    previous !== undefined && previous.scanned > 0 && updatedAt >= previous.updatedAt;
  if (resumable && previous !== undefined) {
    const info = await stat(path).catch(() => undefined);
    // Only an append can be read from the tail. A shorter file (or one of the same
    // length) was rewritten, and the prefix we scanned is not the prefix on disk.
    resumable = info !== undefined && info.size > previous.scanned;
  }
  const from = resumable && previous !== undefined ? previous.scanned : 0;
  const raw = resumable
    ? await readFrom(path, from).catch(() => undefined)
    : await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    return undefined;
  }

  let cwd = resumable && previous !== undefined ? previous.summary.cwd : '';
  let parentId =
    resumable && previous !== undefined ? previous.summary.parentId : undefined;
  let name = resumable && previous !== undefined ? previous.name : undefined;
  let firstUserText = resumable && previous !== undefined ? previous.firstUserText : undefined;
  let messageCount = resumable && previous !== undefined ? previous.summary.messageCount : 0;
  let scanned = from;
  /** Characters consumed up to the last complete line, in this read. */
  let consumed = 0;

  const parseAt = (start: number, end: number) => parseLine(raw.slice(start, end));

  for (let start = 0; start < raw.length; ) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    // Walk the buffer by offset: slicing every line (or `split`ting the whole file
    // into 2000 strings) allocated tens of megabytes per scan, for lines that
    // mostly only needed counting.
    //
    // The last chunk may be a line still being written, and a half-flushed entry
    // must not be read as a (broken) line: it only counts once it parses, which is
    // what the scan did before this shortcut existed.
    const complete = newline !== -1;
    let type: string | undefined;
    if (raw.charCodeAt(start) === 123 /* '{' */) {
      type = complete
        ? (typeAt(raw, start, end) ?? asString(parseAt(start, end)?.['type']))
        : asString(parseAt(start, end)?.['type']);
      if (type === 'message') {
        messageCount += 1;
        if (firstUserText === undefined) {
          const message = asRecord(parseAt(start, end)?.['message']);
          if (message?.['role'] === 'user') {
            firstUserText = textOf(message['content']);
          }
        }
      } else if (type === 'session') {
        if (cwd.length === 0) {
          const header = parseAt(start, end);
          cwd = asString(header?.['cwd']) ?? '';
          // `parentSession` sits in the header, written once, so it is only ever
          // read from the whole-file scan (a resumed scan never sees that line).
          parentId = asString(header?.['parentSession']) ?? undefined;
        }
      } else if ((type === 'session_info' || type === 'session_name') && !name) {
        name = asString(parseAt(start, end)?.['name']);
      }
    }
    if (!complete) {
      // The tail is either a whole entry whose newline has not landed yet — it
      // counted above, so the next scan must start after it — or a half-written
      // line, which is left in place to be read again whole.
      if (type !== undefined) {
        consumed = raw.length;
      }
      break;
    }
    consumed = newline + 1;
    start = newline + 1;
  }

  // Byte offsets are what the next scan resumes from, and they have to sit on a
  // character boundary: measured once from the text, not per line.
  if (consumed > 0) {
    scanned = from + Buffer.byteLength(raw.slice(0, consumed));
  }

  return {
    summary: {
      id: path,
      title: name ?? titleFromText(firstUserText) ?? 'Untitled session',
      cwd,
      updatedAt,
      messageCount,
      parentId,
    },
    scanned,
    name,
    firstUserText,
  };
}

/** The tail of a file, from a byte offset that sits on a character boundary. */
async function readFrom(path: string, from: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (info.size <= from) {
      return '';
    }
    const length = info.size - from;
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, from + filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return buffer.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Only reached for a line that is not in pi's canonical shape. */
function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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

/** A missing file, from `fs.unlink` (ENOENT) or VS Code's workspace filesystem. */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'ENOENT') {
    return true;
  }
  // `vscode.workspace.fs.delete` reports a missing file as FileNotFound; the
  // adapter stays editor-free, so it recognises the shape, not the class.
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === 'FileNotFound' || name === 'EntryNotFound';
}

async function safeReadDir(path: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
