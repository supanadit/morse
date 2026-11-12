export interface FileNode {
  name: string;
  /** Path relative to the project root, the form the host's `readFile` expects. */
  path: string;
  kind: 'dir' | 'file';
  children: FileNode[];
}

/**
 * Turns the flat, cwd-relative list the host's `listFiles` returns into a tree.
 * The list mixes files and directories (the latter with a trailing `/`), so both
 * shapes are folded into one structure; a directory a file implies is created
 * even when the host did not list it separately.
 */
export function buildFileTree(entries: readonly string[]): FileNode[] {
  const root: FileNode = { name: '', path: '', kind: 'dir', children: [] };
  const directories = new Map<string, FileNode>([['', root]]);

  const ensureDirectory = (path: string): FileNode => {
    const existing = directories.get(path);
    if (existing !== undefined) {
      return existing;
    }
    const slash = path.lastIndexOf('/');
    const parent = ensureDirectory(slash === -1 ? '' : path.slice(0, slash));
    const node: FileNode = { name: path.slice(slash + 1), path, kind: 'dir', children: [] };
    parent.children.push(node);
    directories.set(path, node);
    return node;
  };

  for (const raw of entries) {
    const directory = raw.endsWith('/');
    const path = directory ? raw.slice(0, -1) : raw;
    if (path.length === 0) {
      continue;
    }
    if (directory) {
      ensureDirectory(path);
      continue;
    }
    const slash = path.lastIndexOf('/');
    const parent = ensureDirectory(slash === -1 ? '' : path.slice(0, slash));
    if (!parent.children.some((child) => child.kind === 'file' && child.path === path)) {
      parent.children.push({ name: path.slice(slash + 1), path, kind: 'file', children: [] });
    }
  }

  sortTree(root.children);
  return root.children;
}

/** Folders before files, then alphabetical, case-insensitively, at every level. */
function sortTree(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'dir' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const node of nodes) {
    sortTree(node.children);
  }
}

/** A one-character hint at what a file is, so a tree reads without colour. */
export function fileGlyph(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'php', 'rb', 'rs', 'java'].includes(extension)) {
    return '◆';
  }
  if (['md', 'txt', 'rst'].includes(extension)) {
    return '¶';
  }
  if (['json', 'yaml', 'yml', 'toml', 'ini'].includes(extension)) {
    return '⚙';
  }
  if (['css', 'scss', 'less', 'html', 'xml', 'svg'].includes(extension)) {
    return '◈';
  }
  if (['sh', 'bash', 'zsh'].includes(extension)) {
    return '❯';
  }
  return '·';
}

/** The shape a tree row draws. The colour is the stylesheet's, keyed by this name. */
export type IconKind =
  | 'folder'
  | 'folder-open'
  | 'repo'
  | 'session'
  | 'generic'
  | 'code'
  | 'data'
  | 'markdown'
  | 'image'
  | 'shell'
  | 'sql'
  | 'lock'
  | 'git'
  | 'tag';

/**
 * Every kind, as a list. Keyed by the type, so a new kind that is not named here is a
 * compile error — the sprite spec walks this to prove `app.html` defines each shape.
 */
const ICON_SYMBOL: Record<IconKind, true> = {
  folder: true,
  'folder-open': true,
  repo: true,
  session: true,
  generic: true,
  code: true,
  data: true,
  markdown: true,
  image: true,
  shell: true,
  sql: true,
  lock: true,
  git: true,
  tag: true,
};

export const ICON_KINDS = Object.keys(ICON_SYMBOL) as readonly IconKind[];

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
const GIT_FILES = ['.gitignore', '.gitattributes'];
const DATA = ['json', 'yaml', 'yml', 'toml', 'ini'];
const SHELL = ['sh', 'bash', 'zsh'];
const SQL = ['sql'];
const MARKDOWN = ['md', 'markdown', 'rst', 'txt'];
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'];
const CODE = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'php', 'rb', 'rs', 'java',
  'kt', 'c', 'h', 'cpp', 'cs', 'swift', 'dart', 'html', 'htm', 'css', 'scss',
  'less', 'xml',
];

/**
 * The icon a file's row draws, by name. A lockfile and a dotfile are read by their
 * whole name — `.gitignore`'s suffix is not `gitignore` — and everything else by its
 * extension, lowercased.
 */
export function fileIcon(name: string): IconKind {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot <= 0 ? '' : lower.slice(dot + 1);
  if (LOCKFILES.includes(lower) || lower.endsWith('.lock')) {
    return 'lock';
  }
  if (GIT_FILES.includes(lower)) {
    return 'git';
  }
  if (lower === '.env' || lower.startsWith('.env.')) {
    return 'data';
  }
  if (DATA.includes(extension)) {
    return 'data';
  }
  if (SHELL.includes(extension)) {
    return 'shell';
  }
  if (SQL.includes(extension)) {
    return 'sql';
  }
  if (MARKDOWN.includes(extension)) {
    return 'markdown';
  }
  if (IMAGE.includes(extension)) {
    return 'image';
  }
  return CODE.includes(extension) ? 'code' : 'generic';
}

