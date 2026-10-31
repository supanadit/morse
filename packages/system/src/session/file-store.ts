import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MorseSessionRecord } from './record.js';
import type { SessionStore } from './ports.js';

/**
 * The file-backed `SessionStore`: Morse's index on disk, so the sidebar and the
 * tabs survive a restart and two hosts derive the same rows.
 *
 * Layout under the store root:
 *
 * - `records/<shard>/<id>.json` — one JSON per record, sharded by the id's first
 *   two characters so a thousand sessions do not become a directory listing a
 *   host must wade through. A write replaces the file atomically (temp file, then
 *   a rename), so a crash mid-write cannot leave half a record behind.
 * - `index.jsonl` — an append-only line per write, `{ token, record }`. The
 *   record rides along so a line is self-contained, but the *record files* are
 *   authoritative for `list`/`read`; what the index is really for is the token
 *   (`AgentSessionInfo.token` from the last report), which must survive restarts
 *   for reconcile's unchanged-skipping to pay off.
 *
 * Loading applies the index's lines in order, so the last line for a record wins
 * — that is what makes append-only correct without locking: a fresh write is
 * always a new line, never a rewrite of a consumed one. A truncated last line (a
 * crash mid-append) fails to parse and is skipped, losing at most the last write.
 *
 * The index is compacted on first load when it has grown past twice the number of
 * records, so years of updates do not leave a log whose every load replays
 * thousands of stale lines. Removals rewrite the index, too: there is no
 * tombstone representation, and a delete is rare enough that a rewrite is cheap.
 */

const RECORDS_DIR = 'records';
const INDEX_FILE = 'index.jsonl';

/**
 * Past this many index lines a store performs a compaction check. The threshold
 * is deliberately high: a few hundred rewrites of one session's title should not
 * trigger twelve rewrites of the index in a day, and compaction rewrites *at
 * most* `lines` entries, equal to the appends it amortizes.
 */
const COMPACT_LINES = 2_048;

/** A line of `index.jsonl`: the token for that record, as last reported. */
interface IndexLine {
  token?: string;
  record: MorseSessionRecord;
}

export class FileSessionStore implements SessionStore {
  private records: Map<string, MorseSessionRecord>;
  private tokenByMorseId: Map<string, string>;
  private indexLines = 0;
  private indexFile: string;
  private recordsDir: string;

  constructor(rootDir: string) {
    this.recordsDir = join(rootDir, RECORDS_DIR);
    this.indexFile = join(rootDir, INDEX_FILE);
    const loaded = this.load();
    this.records = loaded.records;
    this.tokenByMorseId = loaded.tokens;
    this.indexLines = loaded.indexLines;
  }

  async list(): Promise<MorseSessionRecord[]> {
    return [...this.records.values()];
  }

  async read(id: string): Promise<MorseSessionRecord | undefined> {
    return this.records.get(id);
  }

  async write(record: MorseSessionRecord, token?: string): Promise<void> {
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('A session record needs an id to be stored.');
    }
    this.writeRecordFile(record);
    // A write without a token is a Morse-only change (a rename, say): the engine
    // has not spoken, so the last token it reported stays valid.
    const nextToken = token ?? this.tokenByMorseId.get(id);
    if (nextToken !== undefined) {
      this.tokenByMorseId.set(id, nextToken);
    }
    this.appendIndex({ ...(nextToken === undefined ? {} : { token: nextToken }), record });
    this.records.set(id, record);
  }

  /** The record file for one id, inside the shard its first two characters name. */
  private recordPath(id: string): string {
    return join(this.recordsDir, id.slice(0, 2), `${id}.json`);
  }

  async remove(id: string): Promise<void> {
    if (!this.records.has(id)) {
      return;
    }
    this.records.delete(id);
    this.tokenByMorseId.delete(id);
    try {
      rmSync(this.recordPath(id), { force: true });
    } catch {
      // A record file Morse cannot delete stays on disk, but the in-memory index
      // has already forgotten it: the sidebar stops listing it either way.
    }
    // The index line for the row must go too, or the next load would resurrect
    // its token (and, through compaction, the row's bookkeeping). A rare event —
    // rewrites are fine in a remove.
    this.rewriteIndex(this.records, this.tokenByMorseId);
  }

  async tokens(): Promise<ReadonlyMap<string, string>> {
    return this.tokenByMorseId;
  }

  /** Reads every record file, then replays the index for its tokens. */
  private load(): { records: Map<string, MorseSessionRecord>; tokens: Map<string, string>; indexLines: number } {
    const records = new Map<string, MorseSessionRecord>();
    let shards: string[] = [];
    try {
      shards = readdirSync(this.recordsDir);
    } catch {
      // No records directory yet — a first run with nothing to restore.
    }
    for (const shard of shards) {
      let files: string[] = [];
      try {
        files = readdirSync(join(this.recordsDir, shard));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        const record = this.readRecordFile(shard, file);
        if (record !== undefined) {
          records.set(record.id, record);
        }
      }
    }

    const tokens = new Map<string, string>();
    let indexLines = 0;
    for (const line of this.readIndex()) {
      indexLines += 1;
      const record = line.record;
      if (typeof record.id !== 'string' || record.id.length === 0) {
        continue;
      }
      if (line.token !== undefined) {
        tokens.set(record.id, line.token);
      }
    }

    // After compaction the live count is the rewritten line count, which for the
    // threshold's purpose is simply the record count; before one it is what was
    // loaded.
    const compacted = indexLines > COMPACT_LINES && indexLines > records.size * 2;
    if (compacted) {
      this.rewriteIndex(records, tokens);
      indexLines = records.size;
    }
    return { records, tokens, indexLines };
  }

  private readIndex(): IndexLine[] {
    let raw: string;
    try {
      raw = readFileSync(this.indexFile, 'utf8');
    } catch {
      return [];
    }
    const lines: IndexLine[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object') {
          const candidate = parsed as IndexLine;
          if (typeof candidate.record === 'object' && candidate.record !== null) {
            lines.push(candidate);
          }
        }
      } catch {
        // A torn final line from a crash mid-append: skip the fragment and keep
        // everything before it.
      }
    }
    return lines;
  }

  private readRecordFile(shard: string, file: string): MorseSessionRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.recordsDir, shard, file), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as MorseSessionRecord;
        if (typeof record.id === 'string' && record.id.length > 0) {
          return record;
        }
      }
    } catch {
      // An unreadable record file is skipped: it is one row, not the store.
    }
    return undefined;
  }

  private writeRecordFile(record: MorseSessionRecord): void {
    const target = this.recordPath(record.id);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      mkdirSync(join(this.recordsDir, record.id.slice(0, 2)), { recursive: true });
      writeFileSync(temp, JSON.stringify(record));
      renameSync(temp, target);
    } catch {
      // The in-memory index is still updated; the store stays useful in memory
      // for the rest of the process even when its disk has problems.
      try {
        rmSync(temp, { force: true });
      } catch {
        /* the temp file is a losing battle already */
      }
    }
  }

  private appendIndex(line: IndexLine): void {
    this.indexLines += 1;
    try {
      appendFileSync(this.indexFile, `${JSON.stringify(line)}\n`, 'utf8');
    } catch {
      // Failure to append is a restart-time cost (tokens forget) or, inside a
      // host that keeps running, a reconcile re-writing sessions it would have
      // skipped. Neither is worth failing the site's write for.
    }
  }

  /** Replaces the index with one line per record, carrying each record's token. */
  private rewriteIndex(
    records: ReadonlyMap<string, MorseSessionRecord>,
    tokens: ReadonlyMap<string, string>,
  ): void {
    const temp = `${this.indexFile}.${process.pid}.tmp`;
    try {
      const lines = [...records.values()]
        .map((record) => {
          const token = tokens.get(record.id);
          return JSON.stringify({
            ...(token === undefined ? {} : { token }),
            record,
          });
        })
        .join('\n');
      mkdirSync(this.recordsDir, { recursive: true });
      writeFileSync(temp, lines.length === 0 ? '' : `${lines}\n`);
      renameSync(temp, this.indexFile);
      this.indexLines = records.size;
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* the temp file is a losing battle already */
      }
    }
  }
}
