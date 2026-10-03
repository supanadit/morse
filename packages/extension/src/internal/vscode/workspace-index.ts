import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import type { MorseLogger } from '@morse/core';

/**
 * Directories a file picker never wants, and which make a workspace walk slow
 * enough to feel broken.
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

const MAX_INDEXED_FILES = 5_000;
const INDEX_TTL_MS = 60_000;

interface FileIndex {
  files: string[];
  /** How the list was produced, for the log line. */
  source: 'git' | 'walk';
  at: number;
}

let fileIndex: FileIndex | undefined;
let indexInFlight: Promise<FileIndex> | undefined;

/**
 * Workspace files for the frontend picker.
 *
 * Asking the workspace for every file is the obvious call, but its cost depends
 * on how well the exclude glob is honoured: on a monorepo it can walk
 * node_modules and hit the result cap before reaching the alphabetically later
 * files, which is exactly how the picker failed to find README.md while taking
 * seconds to say so. Walking the tree with an explicit skip list and keeping one
 * index for a minute is predictable — and is what the picker wants anyway: open
 * editors first, then the workspace.
 */
export async function workspaceFiles(logger: MorseLogger): Promise<string[]> {
  const open = openEditorPaths();
  const { files: indexed, source } = await cachedIndex();
  const seen = new Set(open);
  const files = [...open, ...indexed.filter((file) => !seen.has(file))];
  logger.info(
    `File picker: ${files.length} entries via ${source} (${open.length} from open editors)`,
  );
  return files;
}

/**
 * Starts the index before anyone asks for it, so the first picker opens with the
 * list already in memory instead of waiting for a workspace walk.
 */
export function warmFileIndex(logger: MorseLogger): void {
  void cachedIndex().then(
    (index) => logger.info(`Workspace index warmed: ${index.files.length} files (${index.source})`),
    (error: unknown) => logger.warn('Could not warm the workspace index', error),
  );
}

/** Open editors first: the files a picker is most likely to want. */
export function openEditorPaths(): string[] {
  const paths = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      const uri = input?.uri;
      if (uri && uri.scheme === 'file') {
        paths.add(vscode.workspace.asRelativePath(uri, false));
      }
    }
  }
  return [...paths];
}

async function cachedIndex(): Promise<FileIndex> {
  const now = Date.now();
  if (fileIndex && now - fileIndex.at < INDEX_TTL_MS) {
    return fileIndex;
  }
  if (indexInFlight) {
    return indexInFlight;
  }
  indexInFlight = indexWorkspace()
    .then((index) => {
      fileIndex = { ...index, at: Date.now() };
      return fileIndex;
    })
    .finally(() => {
      indexInFlight = undefined;
    });
  return indexInFlight;
}

async function indexWorkspace(): Promise<Omit<FileIndex, 'at'>> {
  const folders = vscode.workspace.workspaceFolders ?? [];

  // Git first: `ls-files` is exactly "tracked files plus untracked files that are
  // not ignored", so `.gitignore` is honoured the way pi honours it, and it is
  // far faster than walking a tree.
  const fromGit: string[] = [];
  let gitCoveredEveryFolder = folders.length > 0;
  for (const folder of folders) {
    const listed = await gitFileList(folder.uri.fsPath);
    if (!listed) {
      gitCoveredEveryFolder = false;
      break;
    }
    fromGit.push(...listed);
  }
  if (gitCoveredEveryFolder) {
    return { files: indexEntries(fromGit), source: 'git' };
  }

  const fromWalk: string[] = [];
  for (const folder of folders) {
    await walk(folder.uri, fromWalk);
    if (fromWalk.length >= MAX_INDEXED_FILES) {
      break;
    }
  }
  return { files: indexEntries(fromWalk), source: 'walk' };
}

/**
 * Turns a list of file paths into the picker's entries: the files plus every
 * directory they imply, the latter marked with a trailing `/` — the same
 * vocabulary pi's own completion uses, so a mention can point at a folder and
 * the frontend can drill into it (`@docs/`).
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
 * `git ls-files` reports paths relative to the repository root, so a workspace
 * folder below that root is handled by stripping `--show-prefix` and dropping
 * everything outside it. `--full-name` is required for that to hold when the
 * folder is a subdirectory of the repository.
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
 * Only *folders* are skipped by the name rules: a dotfile such as `.gitignore` is
 * perfectly pickable, while a dot-folder (`.git`, `.github`) is not.
 */
function isInSkippedDirectory(path: string): boolean {
  const folders = path.split('/').slice(0, -1);
  return folders.some((folder) => SKIPPED_DIRECTORIES.has(folder) || folder.startsWith('.'));
}

async function walk(directory: vscode.Uri, files: string[]): Promise<void> {
  if (files.length >= MAX_INDEXED_FILES) {
    return;
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch {
    // An unreadable directory is not a reason to fail the whole listing.
    return;
  }
  for (const [name, type] of entries) {
    if (files.length >= MAX_INDEXED_FILES) {
      return;
    }
    if (type & vscode.FileType.Directory) {
      // Hidden directories (`.git`, `.cache`, `.venv`, ...) are never picked.
      if (SKIPPED_DIRECTORIES.has(name) || name.startsWith('.')) {
        continue;
      }
      await walk(vscode.Uri.joinPath(directory, name), files);
      continue;
    }
    // A symlink reports `SymbolicLink` plus (sometimes) its target type, so the
    // file check has to tolerate the extra bit.
    if ((type & vscode.FileType.File) || type === vscode.FileType.SymbolicLink) {
      files.push(vscode.workspace.asRelativePath(vscode.Uri.joinPath(directory, name), false));
    }
  }
}
