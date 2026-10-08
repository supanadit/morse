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
