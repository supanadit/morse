import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BotRecord, BotRegistryFile } from './types.js';

/** Morse's index of bots, groups and the conversations between them. */
const REGISTRY_FILE = 'registry.json';
/** A bot's portable identity, beside its config/sessions/workspace directories. */
const IDENTITY_FILE = 'engine.json';

/**
 * Reads the whole registry. A missing file is a fresh install, not an error:
 * every caller starts from an empty v1 registry, and the first save creates it.
 * A present-but-unreadable or malformed file throws instead, so a broken
 * registry is never mistaken for an empty one and then overwritten.
 */
export function loadBotRegistry(root: string): BotRegistryFile {
  const path = join(root, REGISTRY_FILE);
  const raw = readOptional(path);
  if (raw === undefined) {
    return { version: 1, bots: [], groups: [], conversations: [] };
  }
  const parsed = parseJson(path, raw);
  if (!isRegistryFile(parsed)) {
    throw new Error(`Cannot read ${path}: expected a version 1 bot registry.`);
  }
  return parsed;
}

/**
 * Writes the registry in one piece. The write is atomic (a temp file beside it,
 * then a rename), so a crash mid-write leaves the previous registry intact
 * instead of a truncated one — losing this file would lose every bot, group and
 * conversation Morse knows about.
 */
export function saveBotRegistry(root: string, registry: BotRegistryFile): void {
  writeJsonAtomic(join(root, REGISTRY_FILE), registry);
}

/**
 * The identity stored with a bot's directory, or undefined when it has none.
 * A present-but-unreadable or malformed file throws, so "no identity yet" and
 * "broken identity" stay distinguishable by contract.
 */
export function readBotIdentity(botRoot: string): BotRecord | undefined {
  const path = join(botRoot, IDENTITY_FILE);
  const raw = readOptional(path);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseJson(path, raw);
  if (!isBotRecord(parsed)) {
    throw new Error(`Cannot read ${path}: expected a bot identity with a name and engine kind.`);
  }
  return parsed;
}

/**
 * Writes a bot's identity beside its engine directories, with the same atomic
 * write as the registry so a crash cannot leave a half-written identity behind.
 */
export function writeBotIdentity(botRoot: string, record: BotRecord): void {
  writeJsonAtomic(join(botRoot, IDENTITY_FILE), record);
}

/**
 * The conversation id a DM with this bot always has. Bot names are unique and
 * directory-safe, so the DM id can be derived from the name instead of stored.
 */
export function dmConversationId(botName: string): string {
  return `dm-${botName}`;
}

/**
 * A group id nobody can collide with: the slug is only for readability, while
 * the random suffix keeps two groups called "Launch" apart even after one has
 * been deleted and recreated.
 */
export function newGroupId(name: string): string {
  return `grp-${slug(name)}-${randomBytes(2).toString('hex')}`;
}

function slug(name: string): string {
  const slugged = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slugged === '' ? 'group' : slugged;
}

/**
 * Reads a file that may legitimately not exist yet. Only `ENOENT` means "nothing
 * there": a permission, I/O or directory error must surface, because treating it
 * as absent would let the next save overwrite a registry that is present but
 * unreadable.
 */
function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function parseJson(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }
}

function isRegistryFile(value: unknown): value is BotRegistryFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate['version'] === 1 &&
    Array.isArray(candidate['bots']) &&
    Array.isArray(candidate['groups']) &&
    Array.isArray(candidate['conversations'])
  );
}

function isBotRecord(value: unknown): value is BotRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['name'] === 'string' && typeof candidate['engineKind'] === 'string';
}

/**
 * Writes JSON through a temp file in the target's own directory: a rename on the
 * same filesystem is atomic, so a crash leaves either the old file or the new
 * one, never a truncated mix.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, serialized);
    renameSync(temp, path);
  } catch (error) {
    // Some filesystems refuse a rename over an existing file (a Windows mount).
    // Mirroring workbench-store.ts, the fallback writes the target in place: it
    // is not atomic and can leave the temp file behind, but failing a save on a
    // host that cannot rename is worse. Parity with the other store is deliberate.
    try {
      writeFileSync(path, serialized);
    } catch {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
