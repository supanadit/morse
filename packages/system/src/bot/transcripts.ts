import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BotAuthor, BotTranscriptEntry } from '@morse/protocol';

/**
 * Bot conversations' transcripts, kept on disk so a restart does not lose them.
 *
 * One append-only JSON-lines file per conversation under
 * `<botRoot>/transcripts/<conversationId>.jsonl` — a DM's id and a group's id are
 * both stable, directory-safe and unique, so the file name *is* the key. JSONL
 * rather than one JSON array because a transcript is appended to forever: an
 * append is one line, so a crash mid-write can only ever damage the last line,
 * which the reader skips.
 *
 * Reading is paged from the end: the chat opens on the newest page and pulls
 * older pages as the reader scrolls up, so a conversation with thousands of
 * lines costs the same to open as a short one. A "new discussion" is a divider
 * entry written into the same file, which is what makes one chat read as a
 * sequence of engine sessions.
 */
export interface TranscriptPage {
  entries: BotTranscriptEntry[];
  /** True when older entries remain before the first one returned. */
  hasMore: boolean;
}

/** How many entries one page holds when the caller does not say. */
export const TRANSCRIPT_PAGE_SIZE = 40;

export class BotTranscriptStore {
  private readonly dir: string;
  /** Entries appended since the last read, per conversation, so a push never re-reads the file. */
  private readonly tails = new Map<string, BotTranscriptEntry[]>();

  constructor(botRoot: string) {
    this.dir = join(botRoot, 'transcripts');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Every entry in a conversation, oldest first. */
  all(conversationId: string): BotTranscriptEntry[] {
    return this.readAll(conversationId);
  }

  /**
   * The newest page: what the chat shows when it opens. `hasMore` says whether
   * scrolling up has anything to fetch.
   */
  latest(conversationId: string, limit: number = TRANSCRIPT_PAGE_SIZE): TranscriptPage {
    const entries = this.readAll(conversationId);
    const size = Math.max(1, limit);
    if (entries.length <= size) {
      return { entries, hasMore: false };
    }
    return { entries: entries.slice(entries.length - size), hasMore: true };
  }

  /**
   * The page before `beforeId`. An unknown id (a transcript compacted while the
   * chat was open) falls back to the newest page rather than losing the reader's
   * place entirely.
   */
  before(
    conversationId: string,
    beforeId: string | undefined,
    limit: number = TRANSCRIPT_PAGE_SIZE,
  ): TranscriptPage {
    const entries = this.readAll(conversationId);
    const size = Math.max(1, limit);
    const end =
      beforeId === undefined
        ? entries.length
        : (entries.findIndex((entry) => entry.id === beforeId) ?? entries.length);
    const stop = end < 0 ? entries.length : end;
    const start = Math.max(0, stop - size);
    return { entries: entries.slice(start, stop), hasMore: start > 0 };
  }

  /**
   * Everything after `afterId`, oldest first: the slice of the conversation one
   * bot has not been told yet. An absent or unknown id (a first turn, or a
   * transcript compacted since) yields the whole transcript rather than nothing —
   * missed context is a worse failure than repeated context.
   */
  since(conversationId: string, afterId: string | undefined): BotTranscriptEntry[] {
    const entries = this.readAll(conversationId);
    if (afterId === undefined) {
      return entries;
    }
    const seen = entries.findIndex((entry) => entry.id === afterId);
    return seen === -1 ? entries : entries.slice(seen + 1);
  }

  /** The newest entry's id, or undefined for a conversation with no lines yet. */
  lastId(conversationId: string): string | undefined {
    return this.readAll(conversationId).at(-1)?.id;
  }

  /** Appends one entry, durably enough that a crash cannot corrupt earlier ones. */
  append(conversationId: string, entry: BotTranscriptEntry): BotTranscriptEntry {
    const path = this.pathFor(conversationId);
    // One `write` of one complete line: a partially written tail line is skipped
    // by `readAll`, so an interrupted append costs at most that entry.
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const tail = this.tails.get(conversationId);
    if (tail === undefined) {
      this.tails.set(conversationId, [entry]);
    } else {
      tail.push(entry);
    }
    return entry;
  }

  /** Records a discussion boundary: the marker that keeps engine sessions apart. */
  appendDivider(conversationId: string, at: number, note?: string): BotTranscriptEntry {
    const author: BotAuthor = { role: 'discussion' };
    return this.append(conversationId, {
      id: randomUUID(),
      author,
      text: note ?? 'New discussion',
      at,
    });
  }

  /** Drops a conversation's transcript, for a conversation that no longer exists. */
  forget(conversationId: string): void {
    rmSync(this.pathFor(conversationId), { force: true });
    this.tails.delete(conversationId);
  }

  /** Every conversation this store holds a transcript for. */
  conversations(): string[] {
    if (!existsSync(this.dir)) {
      return [];
    }
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length));
  }

  private pathFor(conversationId: string): string {
    // The id comes from Morse's own registry (a DM's username or a generated
    // group id), but it is still validated here: this value becomes a path.
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_-]*$/.test(conversationId)) {
      throw new Error(`"${conversationId}" is not a usable conversation id.`);
    }
    return join(this.dir, `${conversationId}.jsonl`);
  }

  /**
   * Reads a whole file. Lines are parsed one at a time so a damaged line — the
   * tail of a process killed mid-append, or a hand-edit — is skipped instead of
   * costing the rest of the transcript.
   */
  private readAll(conversationId: string): BotTranscriptEntry[] {
    const path = this.pathFor(conversationId);
    if (!existsSync(path) || statSync(path).size === 0) {
      return [];
    }
    const entries: BotTranscriptEntry[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isEntry(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // A half-written line at the tail of an interrupted append.
      }
    }
    return entries;
  }
}

function isEntry(value: unknown): value is BotTranscriptEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const author = candidate['author'] as Record<string, unknown> | undefined;
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['text'] === 'string' &&
    typeof candidate['at'] === 'number' &&
    typeof author === 'object' &&
    author !== null &&
    typeof author['role'] === 'string'
  );
}
