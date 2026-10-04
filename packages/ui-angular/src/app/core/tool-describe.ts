import type { ToolTranscriptItem } from '@morse/protocol';

/**
 * What a tool call is about, from its name alone. pi tool names vary by
 * provider (`edit`, `write`, `str_replace`, `read_file`, `grep_search`…), so the
 * classification is by substring — the same rule the timeline has always used.
 */
export type ToolKind = 'edit' | 'read' | 'search' | 'shell' | 'other';

export function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch')) {
    return 'edit';
  }
  if (lower.includes('read')) {
    return 'read';
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return 'search';
  }
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) {
    return 'shell';
  }
  return 'other';
}

/** The imperative label: "Edit", "Read", "Search", "Run" — or the tool's own name. */
export function toolVerb(item: ToolTranscriptItem): string {
  switch (toolKind(item.name)) {
    case 'edit':
      return 'Edit';
    case 'read':
      return 'Read';
    case 'search':
      return 'Search';
    case 'shell':
      return 'Run';
    default:
      return item.name;
  }
}

/**
 * Present tense, for a status line: "Editing notes.md", "Running npm test".
 * The sidebar reads as "what is happening right now", which a bare verb does
 * not.
 */
export function toolGerund(item: ToolTranscriptItem): string {
  switch (toolKind(item.name)) {
    case 'edit':
      return 'Editing';
    case 'read':
      return 'Reading';
    case 'search':
      return 'Searching';
    case 'shell':
      return 'Running';
    default:
      return item.name;
  }
}

/** The glyph shown next to a call in the timeline. */
export function toolGlyph(item: ToolTranscriptItem): string {
  switch (toolKind(item.name)) {
    case 'edit':
      return '✎';
    case 'search':
      return '⌕';
    case 'shell':
      return '❯';
    default:
      return '☰';
  }
}

/** The tool title without the `name: ` prefix pi puts in front of it. */
export function toolTitle(item: ToolTranscriptItem): string {
  return item.title.startsWith(`${item.name}: `)
    ? item.title.slice(item.name.length + 2)
    : item.title;
}

/** The last path segment: `src/app/file.ts` -> `file.ts`. */
export function toolFileName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return cut === -1 ? clean : clean.slice(cut + 1);
}

/**
 * The file an edit tool changed, or `null` when the call is not a file edit.
 * Only edits carry a child row: the file is what the action produced, and
 * repeating it under a read would just echo the parent row.
 */
export function toolChangedFile(item: ToolTranscriptItem): string | null {
  if (toolKind(item.name) !== 'edit') {
    return null;
  }
  const raw = toolTitle(item);
  return raw.length > 0 && raw !== item.name ? raw : null;
}
