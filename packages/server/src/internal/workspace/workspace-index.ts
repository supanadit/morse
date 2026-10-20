import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { UnsupportedByHostError, type MorseLogger } from '@morse/core';

/**
 * Directories a file picker never wants, and which make a tree walk slow enough
 * to feel broken. Mirrors the VS Code host's list on purpose: a browser host and
 * a webview host should offer the same files for the same project. Exported for
 * `workspace-search.ts`, which skips the same noise while grepping.
 */
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  'vendor',
  'venv',
  '__pycache__',
  '.angular',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
]);

const MAX_INDEXED_FILES = 5_000;
const INDEX_TTL_MS = 60_000;
/**
 * How many directories keep a warm index. A global browser host switches
 * projects freely, and each cached index can hold thousands of paths, so the
 * cache is bounded: the least recently used project is dropped once the cap is
 * passed. Nothing else ever releases an index — unlike the VS Code host, which
 * has a single workspace folder — so without this the map would grow for the
 * host's entire lifetime.
 */
const MAX_CACHED_INDEXES = 8;

interface FileIndex {
  files: string[];
  /** How the list was produced, for the log line. */
  source: 'git' | 'walk';
  at: number;
}

/**
 * One index per directory, capped and LRU-ordered: a global host browses many
 * projects, but only a handful are ever warm at once. Ordered oldest-first, so
 * the first key is the eviction candidate.
 */
const indexes = new Map<string, FileIndex>();
const inFlight = new Map<string, Promise<FileIndex>>();

/**
 * Forgets cached indexes — every directory, or just one. Called when a session
 * leaves the hot set (its project is no longer being viewed) and on host
 * shutdown, so a global host does not retain a listing per project it has ever
 * seen. Exposed for the session-removal hook and for tests.
 */
export function clearWorkspaceIndex(cwd?: string): void {
  if (cwd === undefined) {
    indexes.clear();
    inFlight.clear();
    return;
  }
  indexes.delete(cwd);
  inFlight.delete(cwd);
}

/**
 * Entries under `cwd`, relative to it, for the frontend's `@mention` picker:
 * files *and* directories, the latter with a trailing `/` — the vocabulary pi's
 * own completion offers (fd with `--type f --type d`).
 *
 * The VS Code host lists its workspace folders; the browser host has no
 * workspace folder, so it lists the active session's directory — the cwd pi
 * resolves a mention against. Git first (`ls-files` honours `.gitignore` and is
 * far faster than a walk), then a capped walk with an explicit skip list.
 */
export async function workspaceFiles(
  cwd: string,
  logger: MorseLogger,
  options: { fresh?: boolean } = {},
): Promise<string[]> {
  const { files, source } = await cachedIndex(cwd, options.fresh === true);
  logger.info(`File picker: ${files.length} entries via ${source} in ${cwd}`);
  return files;
}

/**
 * One directory's entries for the Explorer's lazy tree: the root level the pane
 * draws first, then each folder's own level as it opens. The vocabulary is
 * `listFiles`' — paths relative to the project, directories carrying the
 * trailing `/` — so the frontend merges a level straight into the flat listing
 * it already holds. Unlike the index, this is one `readdir`: no cap, so every
 * entry of the level is there, which is what keeps a parent directory of twenty
 * repositories from losing the ones past the index's first five thousand files.
 *
 * The path resolves inside the project the way `readFile`'s does: the browser
 * host never lists a directory the client names outside the session's
 * directory, and an absolute path is a client naming a place the session does
 * not own rather than a path to reinterpret.
 */
export async function listProjectDirectory(cwd: string, requested: string): Promise<string[]> {
  const target = resolveDirectoryWithin(cwd, requested);
  let listed: Dirent[];
  try {
    listed = await readdir(target, { withFileTypes: true });
  } catch {
    // An unreadable or vanished directory answers as none: the row that asked
    // for it shows no children instead of the whole tree failing.
    return [];
  }
  const parent = toPosix(relative(cwd, target));
  const entries: string[] = [];
  for (const entry of listed) {
    const path = toPosix(join(parent, entry.name));
    if (entry.isDirectory()) {
      // The index's skip rules, level by level: no build directories, and no
      // dot-folder (`.git`, `.github`) — while a dot-*file* stays pickable.
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      entries.push(`${path}/`);
      continue;
    }
    // A symlink reports as neither, so it is listed the way the walk lists it.
    if (entry.isFile() || entry.isSymbolicLink()) {
      entries.push(path);
    }
  }
  return entries.sort();
}

/**
 * Resolves a client's directory under `cwd` (empty is the project root itself)
 * and refuses anything that escapes it, exactly like `resolveWithin` does for a
 * previewed file.
 */
function resolveDirectoryWithin(cwd: string, requested: string): string {
  if (isAbsolute(requested)) {
    throw new UnsupportedByHostError('The project only lists its own directories.');
  }
  const target = resolve(cwd, requested);
  const rel = relative(cwd, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new UnsupportedByHostError('The project only lists its own directories.');
  }
  return target;
}

async function cachedIndex(cwd: string, fresh: boolean): Promise<FileIndex> {
  const now = Date.now();
  const cached = indexes.get(cwd);
  if (!fresh && cached && now - cached.at < INDEX_TTL_MS) {
    // A hit is use: move it to the most-recently-used end so an actively
    // browsed project is not the one a later project evicts.
    indexes.delete(cwd);
    indexes.set(cwd, cached);
    return cached;
  }
  const pending = inFlight.get(cwd);
  if (pending) {
    return pending;
  }
  const task = indexWorkspace(cwd)
    .then((index) => {
      const entry: FileIndex = { ...index, at: Date.now() };
      // Re-inserting an existing key moves it to the end (insertion order), so
      // a refreshed index counts as most-recently-used for the LRU below.
      indexes.delete(cwd);
      indexes.set(cwd, entry);
      evictIfNeeded();
      return entry;
    })
    .finally(() => {
      inFlight.delete(cwd);
    });
  inFlight.set(cwd, task);
  return task;
}

/** Drops the least recently used indexes once the cache is over its cap. */
function evictIfNeeded(): void {
  while (indexes.size > MAX_CACHED_INDEXES) {
    const oldest = indexes.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    indexes.delete(oldest);
  }
}

async function indexWorkspace(cwd: string): Promise<Omit<FileIndex, 'at'>> {
  const fromGit = await gitFileList(cwd);
  if (fromGit) {
    return { files: indexEntries(fromGit), source: 'git' };
  }
  const fromWalk: string[] = [];
  await walk(cwd, cwd, fromWalk);
  return { files: indexEntries(fromWalk), source: 'walk' };
}

/**
 * Turns a list of file paths into the picker's entries: the files plus every
 * directory they imply, the latter marked with a trailing `/`. Deriving the
 * directories from the files keeps the git and walk listings identical and never
 * offers a folder the agent could not reach anyway. The frontend ranks a
 * directory first and lets the user drill into it (`@docs/` lists its contents).
 */
function indexEntries(paths: string[]): string[] {
  const entries = new Set(dedupe(paths).slice(0, MAX_INDEXED_FILES));
  for (const path of [...entries]) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      entries.add(`${segments.slice(0, depth).join('/')}/`);
    }
  }
  return [...entries].sort();
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * `git ls-files` reports paths relative to the repository root; a directory
 * below that root is handled by stripping `--show-prefix` and dropping entries
 * outside it, so the result is always cwd-relative. `--full-name` is what makes
 * that true when the cwd is a subdirectory: without it git prints cwd-relative
 * paths and every entry would be filtered out.
 */
async function gitFileList(cwd: string): Promise<string[] | undefined> {
  try {
    const [prefix, listed] = await Promise.all([
      runGit(['rev-parse', '--show-prefix'], cwd),
      runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name'], cwd),
    ]);
    if (listed === undefined) {
      return undefined;
    }
    const root = prefix?.trim() ?? '';
    return listed
      .split('\0')
      .filter((path) => path.length > 0)
      .filter((path) => root.length === 0 || path.startsWith(root))
      .map((path) => path.slice(root.length))
      .filter((path) => path.length > 0 && !isInSkippedDirectory(path));
  } catch {
    return undefined;
  }
}

function runGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

/**
 * Only *folders* are skipped by the name rules: a dotfile such as `.gitignore`
 * is perfectly pickable, while a dot-folder (`.git`, `.github`) is not.
 */
function isInSkippedDirectory(path: string): boolean {
  const folders = path.split('/').slice(0, -1);
  return folders.some((folder) => SKIPPED_DIRECTORIES.has(folder) || folder.startsWith('.'));
}

async function walk(root: string, directory: string, files: string[]): Promise<void> {
  if (files.length >= MAX_INDEXED_FILES) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // An unreadable directory is not a reason to fail the whole listing.
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_INDEXED_FILES) {
      return;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Hidden directories (`.git`, `.cache`, `.venv`, ...) are never picked.
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      await walk(root, full, files);
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(toPosix(relative(root, full)));
    }
  }
}

/** Mention paths read with `/` on every platform, the way pi prints them. */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}
