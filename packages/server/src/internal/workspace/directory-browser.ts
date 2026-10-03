import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Heavy or generated directories a project picker never wants to step into.
 * Mirrors the file picker's skip list so both hosts hide the same noise.
 */
const SKIPPED_DIRECTORIES = new Set([
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

/** One subdirectory row of the browser. */
export interface DirectoryEntry {
  name: string;
  path: string;
}

/** What the frontend's folder modal needs to render one directory. */
export interface DirectoryListing {
  /** Absolute path of the directory being shown. */
  path: string;
  /** Absolute parent, absent when `path` is the filesystem root. */
  parent?: string;
  directories: DirectoryEntry[];
  /** True when `path` itself is a git worktree — a strong "this is a project" hint. */
  isGitRepo: boolean;
  /** Shortcuts the modal offers: the allow-list, the home dir, the default workspace. */
  roots: DirectoryEntry[];
}

export interface BrowseOptions {
  /** Directories the operator allowed the agent to work in (`MORSE_PROJECTS`). */
  roots?: readonly string[];
  /** Where to start when the client does not name a path. */
  defaultPath: string;
}

/**
 * Lists the subdirectories of one folder on the host's filesystem.
 *
 * The browser host serves a machine, not a webview with a workspace folder, so
 * the user has to be able to point the agent at any directory. Browsing is
 * read-only and never creates anything; whether a session may actually run in
 * the chosen folder stays `ProjectPolicy`'s call (the host decorates the result
 * with `canOpen`).
 */
export async function browseDirectory(
  path: string | undefined,
  options: BrowseOptions,
): Promise<DirectoryListing> {
  const requested = path?.trim();
  const start = resolve(requested && requested.length > 0 ? requested : options.defaultPath);

  // `resolve` already made it absolute; this guard is for the caller's sake when
  // a relative path slips through (it would otherwise be resolved against the
  // server's cwd, which is rarely what the user typed).
  if (requested && !isAbsolute(requested)) {
    throw new Error(`A folder path must be absolute: ${requested}`);
  }

  const entries = await readdir(start, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !shouldSkip(entry.name))
    .map((entry) => ({ name: entry.name, path: join(start, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const parent = dirname(start);
  return {
    path: start,
    parent: parent === start ? undefined : parent,
    directories,
    isGitRepo: await isGitRepo(start),
    roots: shortcutRoots(options),
  };
}

/** Hidden folders are noise when the point is to pick a project. */
function shouldSkip(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name);
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await stat(join(path, '.git'));
    return true;
  } catch {
    return false;
  }
}

function shortcutRoots(options: BrowseOptions): DirectoryEntry[] {
  const seen = new Set<string>();
  const roots: DirectoryEntry[] = [];
  for (const candidate of [...(options.roots ?? []), homedir(), options.defaultPath]) {
    if (!candidate || !isAbsolute(candidate)) {
      continue;
    }
    const path = resolve(candidate);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    roots.push({ name: basename(path) || path, path });
  }
  return roots;
}
