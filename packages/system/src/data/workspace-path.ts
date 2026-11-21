/** The file-picker vocabulary both hosts share: skipped folders and index shape. */

/**
 * Directories a file picker never wants, and which make a tree walk slow enough
 * to feel broken. A browser host and a webview host should offer the same files
 * for the same project, so the list lives here.
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

export const MAX_INDEXED_FILES = 5_000;

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Turns a list of file paths into the picker's entries: the files plus every
 * directory they imply, the latter marked with a trailing `/` — the same
 * vocabulary pi's own completion uses, so a mention can point at a folder and
 * the frontend can drill into it (`@docs/`).
 */
export function indexEntries(paths: string[]): string[] {
  const entries = new Set(dedupe(paths).slice(0, MAX_INDEXED_FILES));
  for (const path of [...entries]) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      entries.add(`${segments.slice(0, depth).join('/')}/`);
    }
  }
  return [...entries].sort();
}

/**
 * Only *folders* are skipped by the name rules: a dotfile such as `.gitignore` is
 * perfectly pickable, while a dot-folder (`.git`, `.github`) is not.
 */
export function isInSkippedDirectory(path: string): boolean {
  const folders = path.split('/').slice(0, -1);
  return folders.some((folder) => SKIPPED_DIRECTORIES.has(folder) || folder.startsWith('.'));
}
