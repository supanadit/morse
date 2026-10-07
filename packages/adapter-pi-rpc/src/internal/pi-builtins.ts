import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { PiSpawn } from './resolve-pi.js';

/**
 * pi's TUI slash commands, read from the installed pi binary itself.
 *
 * pi's RPC protocol (`get_commands`) deliberately exposes only extension
 * commands, prompt templates and skills — the builtins (`/settings`, `/model`,
 * `/reload`, ...) are private to pi's own TUI process. But the catalog is a
 * stable exported module in pi's dist (`dist/core/slash-commands.js`), and it
 * is the same constant pi's own autocomplete builds from. Reading it at spawn
 * (and whenever the file's mtime changes, so an in-flight `pi update` is picked
 * up on the next palette refresh) gives the palette exactly what the TUI shows
 * with nothing hardcoded on Morse's side.
 *
 * Read order, all best-effort:
 * 1. extract the array literal from the compiled file and evaluate just that
 *    literal in a fresh VM context (fast, no subprocess);
 * 2. on any evaluation failure, import the real module in a one-shot node
 *    subprocess — the same trust boundary as spawning pi itself;
 * 3. if both fail, the caller gets `undefined` and surfaces a diagnostic rather
 *    than a silently trimmed palette.
 */

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
/** `dist/core/slash-commands.js`, relative to the pi package root. */
const SLASH_COMMANDS_FILE = join('dist', 'core', 'slash-commands.js');
/** Walk-up depth cap — pi's entry can be `bin/`, `dist/`, `dist/bundle/`. */
const MAX_ROOT_DEPTH = 5;

/** A pi builtin, exactly as pi declares it (see pi's own `BuiltinSlashCommand`). */
export interface BuiltinSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** The read result: the commands plus the pi install they came from. */
export interface PiBuiltinsResult {
  /** pi package root the file was read from (holds `package.json`). */
  root: string;
  /** pi version from that root's manifest, when it could be read. */
  version?: string;
  commands: BuiltinSlashCommand[];
}

interface CacheEntry {
  mtimeMs: number;
  result: PiBuiltinsResult;
}

/** Keyed by package root; invalidated by the file's mtime, not by a TTL. */
const cache = new Map<string, CacheEntry>();

/**
 * The pi package root for a pi entry (`pi` binary or a `dist/**[.js]` entry):
 * realpath the entry, then walk up to the manifest whose name is pi's. Mirrors
 * pi's own version lookup walk.
 */
export function piPackageRoot(entry: string, maxDepth = MAX_ROOT_DEPTH): string | undefined {
  let directory: string;
  try {
    const resolved = realpathSync(entry);
    directory = statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < maxDepth && directory !== dirname(directory); depth += 1) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (parsed.name === PI_PACKAGE_NAME) {
          return directory;
        }
      } catch {
        // Unreadable manifest: keep walking.
      }
    }
    directory = dirname(directory);
  }
  return undefined;
}

const piEntry = (spawn: PiSpawn): string | undefined =>
  spawn.source === 'node-entry' ? spawn.args.find((arg) => /\.(?:c|m)?js$/.test(arg)) : spawn.command;

/**
 * pi's builtins as the installed binary declares them, cached until the file
 * on disk changes. `spawn` is what pi was launched with, so the same install
 * the session runs against is the one the catalog reflects.
 */
export function getBuiltinSlashCommands(spawn: PiSpawn | undefined): PiBuiltinsResult | undefined {
  if (!spawn) {
    return undefined;
  }
  const entry = piEntry(spawn);
  if (!entry) {
    return undefined;
  }
  const root = piPackageRoot(entry);
  if (!root) {
    return undefined;
  }
  const file = join(root, SLASH_COMMANDS_FILE);
  if (!existsSync(file)) {
    return undefined;
  }
  const mtimeMs = statSync(file).mtimeMs;
  const cached = cache.get(root);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }
  let result: PiBuiltinsResult | undefined;
  try {
    result = readFromRoot(root, file);
    if (result) {
      cache.set(root, { mtimeMs, result });
    }
  } catch {
    return undefined;
  }
  return result;
}

/** Lowers the cache: the next read re-parses even an unchanged file. */
export function clearBuiltinCommandsCache(): void {
  cache.clear();
}

function readFromRoot(root: string, file: string): PiBuiltinsResult | undefined {
  const commands = extractArrayLiteral(file) ?? importInSubprocess(file);
  if (!commands || commands.length === 0) {
    return undefined;
  }
  const version = versionOf(root);
  return { root, version, commands };
}

function versionOf(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof parsed.version !== 'string') {
      return undefined;
    }
    const version = parsed.version.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The compiled module exports a self-contained array literal of plain objects.
 * Find `BUILTIN_SLASH_COMMANDS = [`, take the bracket-balanced span (quote- and
 * escape-aware so a description containing brackets cannot cut the scan short)
 * and evaluate only that expression — no imports, no pi code, and the sandbox
 * has no globals to touch.
 */
function extractArrayLiteral(file: string): BuiltinSlashCommand[] | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const assignment = text.indexOf('BUILTIN_SLASH_COMMANDS');
  const start = text.indexOf('[', assignment);
  if (assignment === -1 || start === -1) {
    return undefined;
  }
  const literal = balancedSpan(text, start);
  if (literal === undefined) {
    return undefined;
  }
  let evaluated: unknown;
  try {
    evaluated = runInNewContext(`(${literal})`, Object.create(null));
  } catch {
    return undefined; // The subprocess read below handles non-literal entries.
  }
  return normalized(evaluated);
}

/** The source from `start` through the `]` that closes it, undefined if unbalanced. */
function balancedSpan(text: string, start: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      // Template placeholders open a nested string context: track the brace
      // depth inside `${ ... }` so the closing `}` does not confuse the count.
      if (quote !== '`' && char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function importInSubprocess(file: string): BuiltinSlashCommand[] | undefined {
  let script: string;
  try {
    // `--input-type=module` makes the expression ESM regardless of cwd; the URL
    // avoids any path-escaping question and forces a fresh module resolution.
    script =
      `import(${JSON.stringify(pathToFileURL(file).href)})` +
      '.then((m) => { process.stdout.write(JSON.stringify(m.BUILTIN_SLASH_COMMANDS ?? null)); })' +
      '.catch(() => process.exit(1));';
  } catch {
    // An unresolvable file URL means the path is not a file we can import.
    return undefined;
  }
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (run.status !== 0 || typeof run.stdout !== 'string' || run.stdout.length === 0) {
    return undefined;
  }
  try {
    return normalized(JSON.parse(run.stdout));
  } catch {
    return undefined;
  }
}

/** Duplicates and entries without a name are dropped; fields are narrowed. */
function normalized(value: unknown): BuiltinSlashCommand[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const commands: BuiltinSlashCommand[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') {
      continue;
    }
    const name = record.name.trim();
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const command: BuiltinSlashCommand = { name };
    if (typeof record.description === 'string' && record.description.length > 0) {
      command.description = record.description;
    }
    if (typeof record.argumentHint === 'string' && record.argumentHint.length > 0) {
      command.argumentHint = record.argumentHint;
    }
    commands.push(command);
  }
  return commands.length > 0 ? commands : undefined;
}