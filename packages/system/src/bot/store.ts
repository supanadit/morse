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
    return { version: 2, bots: [], groups: [], conversations: [] };
  }
  const parsed = parseJson(path, raw);
  // A version 1 file is migrated as it is read: its bots' names doubled as
  // handles, which version 2 split into `username` (identity) and `name` (label).
  if (isRegistryFileV1(parsed)) {
    return migrateV1(root, parsed);
  }
  if (!isRegistryFile(parsed)) {
    throw new Error(`Cannot read ${path}: expected a bot registry (version 1 or 2).`);
  }
  return parsed;
}

/** A version 1 registry: bots had only a name, which was also their directory. */
interface RegistryV1 {
  version: 1;
  bots: Array<BotRecord & { username?: string }>;
  groups: Array<{ id: string; name: string; members: string[]; lead?: string; chainCap: number }>;
  conversations: BotRegistryFile['conversations'];
}

/**
 * A version 1 bot's name did double duty: display label, directory and mention.
 * Version 2 splits that, so every old bot gets a username derived from its name
 * — and its directory, its DM conversation and every conversation that named it
 * move with it. The registry is written back once the move is done, so this runs
 * exactly once per install.
 */
function migrateV1(root: string, old: RegistryV1): BotRegistryFile {
  const taken = new Set<string>();
  // Old display name (which was also the handle and the directory) → username.
  const renames = new Map<string, string>();
  const bots: BotRecord[] = old.bots.map((bot) => {
    const username = uniqueUsername(slug(bot.name), taken);
    taken.add(username);
    renames.set(bot.name, username);
    return { ...bot, username };
  });
  const rename = (handle: string): string => renames.get(handle) ?? handle;
  const displayName = (username: string): string =>
    bots.find((one) => one.username === username)?.name ?? username;
  const migrated: BotRegistryFile = {
    version: 2,
    bots,
    groups: old.groups.map((group) => ({
      ...group,
      members: group.members.map(rename),
      ...(group.lead === undefined ? {} : { lead: rename(group.lead) }),
    })),
    conversations: old.conversations.map((conversation) => {
      const members = conversation.members.map(rename);
      const dm = conversation.kind === 'dm' ? members[0] : undefined;
      return {
        ...conversation,
        // A DM's id is derived from its member's username, so it moves with it.
        id: dm === undefined ? conversation.id : dmConversationId(dm),
        title: dm === undefined ? conversation.title : displayName(dm),
        members,
        ...(conversation.lead === undefined ? {} : { lead: rename(conversation.lead) }),
        sessions: Object.fromEntries(
          Object.entries(conversation.sessions).map(([handle, ref]) => [rename(handle), ref]),
        ),
      };
    }),
  };
  // The directory carried the old name; a username is the identity now. A failed
  // rename (a locked directory) leaves the tree where it was rather than losing
  // the bot: the next `updateBot` writes it in its new place.
  for (const [before, after] of renames) {
    if (before === after) {
      continue;
    }
    try {
      renameSync(join(root, before), join(root, after));
      writeBotIdentity(join(root, after), bots.find((one) => one.username === after) as BotRecord);
    } catch {
      // Keep going: a bot whose directory stayed put is still listed and usable.
    }
  }
  saveBotRegistry(root, migrated);
  return migrated;
}

/** A username nobody holds yet, by suffixing `-2`, `-3`, … */
function uniqueUsername(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
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
 * The conversation id a DM with this bot always has. Usernames are unique and
 * directory-safe, so the id is derived from the handle instead of stored.
 */
export function dmConversationId(username: string): string {
  return `dm-${username}`;
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
    candidate['version'] === 2 &&
    Array.isArray(candidate['bots']) &&
    candidate['bots'].every(isRegistryBot) &&
    Array.isArray(candidate['groups']) &&
    candidate['groups'].every(isRegistryGroup) &&
    Array.isArray(candidate['conversations']) &&
    candidate['conversations'].every(isRegistryConversation)
  );
}

/**
 * The minimum an element must carry for the service to use it. Deliberately not
 * a full schema: `engine.json` is the identity and its reader owns the rest, but
 * a `null` or a number in an array would fail later inside a round, so the file
 * is rejected at load with its path instead.
 */
function isRegistryBot(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['username'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['engineKind'] === 'string'
  );
}

/** A version 1 bot: no username yet, so a name and an engine are all it carried. */
function isRegistryBotV1(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['name'] === 'string' && typeof candidate['engineKind'] === 'string';
}

function isRegistryGroup(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    Array.isArray(candidate['members']) &&
    candidate['members'].every((member) => typeof member === 'string')
  );
}

function isRegistryConversation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['id'] === 'string' && typeof candidate['kind'] === 'string';
}

function isBotRecord(value: unknown): value is BotRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['username'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['engineKind'] === 'string'
  );
}

/** A version 1 registry as it is on disk: bots may still lack a username. */
function isRegistryFileV1(value: unknown): value is RegistryV1 {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate['version'] === 1 &&
    Array.isArray(candidate['bots']) &&
    candidate['bots'].every(isRegistryBotV1) &&
    Array.isArray(candidate['groups']) &&
    candidate['groups'].every(isRegistryGroup) &&
    Array.isArray(candidate['conversations']) &&
    candidate['conversations'].every(isRegistryConversation)
  );
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
