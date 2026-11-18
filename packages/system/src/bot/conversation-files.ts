import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './store.js';

/**
 * One directory of per-conversation JSON files.
 *
 * The delivery queue and the turn history hold different things — one moves
 * forward as work runs, the other is written once a turn settles — but both are
 * "one array per conversation, named by the conversation's id", and the
 * plumbing that makes that safe is the same: the id becomes a path, the file is
 * read whole or written atomically, and a broken file must never be mistaken
 * for an empty one. Keeping one copy of it here means the rule that makes an id
 * path-safe, and the rule for what a malformed file reads as, cannot drift
 * between the two stores.
 *
 * Rows are the caller's: this module checks the file's shape through the guard
 * it is given, not what a row means. Each store keeps its own validator and its
 * own sweep policy, because those are the parts that genuinely differ.
 */
export class ConversationFiles<Row> {
  private readonly dir: string;
  private readonly expected: string;
  private readonly isRow: (value: unknown) => value is Row;

  /**
   * @param dir the directory this store owns; every `*.json` in it is one
   *   conversation's file
   * @param expected what the file holds, for the error a malformed one throws
   * @param isRow the caller's row guard, applied to every element on read
   */
  constructor(dir: string, expected: string, isRow: (value: unknown) => value is Row) {
    this.dir = dir;
    this.expected = expected;
    this.isRow = isRow;
  }

  /**
   * Every conversation this directory holds a file for.
   *
   * Only a missing directory means "nothing here yet". Any other error is
   * surfaced: a directory that cannot be listed is not one that holds nothing,
   * and a sweep that read it as empty would leave every file in it untouched.
   */
  conversations(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  }

  /**
   * Every row in a conversation's file, in file order.
   *
   * A missing file is a conversation with nothing recorded yet, not an error:
   * only `ENOENT` reads as an empty list, the same rule the registry uses, so a
   * present but unreadable file surfaces instead of being treated as empty and
   * overwritten by the next write. A malformed one throws naming its path.
   */
  all(conversationId: string): Row[] {
    const path = this.pathFor(conversationId);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
    }
    if (!Array.isArray(parsed) || !parsed.every((row) => this.isRow(row))) {
      throw new Error(`Cannot read ${path}: expected ${this.expected}.`);
    }
    return parsed;
  }

  /** Replaces a conversation's file in one atomic write. */
  write(conversationId: string, rows: Row[]): void {
    writeJsonAtomic(this.pathFor(conversationId), rows);
  }

  /** Removes a conversation's file, for a conversation that no longer exists. */
  forget(conversationId: string): void {
    rmSync(this.pathFor(conversationId), { force: true });
  }

  /**
   * A sweep failure, named by the file it could not handle. The path is built
   * without validating the id: it came from a directory listing, so a file
   * named for an id the store would refuse must still be named in the report
   * instead of vanishing from it.
   */
  failure(conversationId: string, error: unknown): string {
    return `${this.filePath(conversationId)}: ${(error as Error).message}`;
  }

  private pathFor(conversationId: string): string {
    // The id comes from Morse's own registry (a DM's username or a generated
    // group id), but it is still validated here: this value becomes a path.
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_-]*$/.test(conversationId)) {
      throw new Error(`"${conversationId}" is not a usable conversation id.`);
    }
    return this.filePath(conversationId);
  }

  private filePath(conversationId: string): string {
    return join(this.dir, `${conversationId}.json`);
  }
}

/**
 * Reports every file a sweep could not handle, after the sweep has finished.
 * Failing loudly is deliberate — a corrupt file must be repaired, not ignored —
 * but it must not be all-or-nothing: one bad file should not leave every other
 * conversation unswept.
 */
export function failIfAny(action: string, failures: readonly string[], noun: string): void {
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    `Cannot ${action}: ${failures.length} ${noun} file(s) failed — ${failures.join(' | ')}`,
  );
}
