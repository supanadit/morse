/**
 * The command palette's model: what an entry is, how a query narrows it, and
 * how the survivors are ranked and grouped. Pure functions, so the behaviour —
 * including the hybrid filter — is testable without a component.
 */

/** Where an entry came from. Also the section it is printed under. */
export type PaletteKind =
  | 'command'
  | 'tab'
  | 'session'
  | 'project'
  | 'file'
  | 'model'
  | 'thinking';

/** One selectable row. Presentational only; the palette owns the actions. */
export interface PaletteEntry {
  /** `kind:key` — stable across re-renders and unique within one list. */
  id: string;
  kind: PaletteKind;
  /** Primary label, the string the highlight and the query read first. */
  label: string;
  /** A second, quieter line: a path, a working directory, a context size. */
  description?: string;
  /** A small right-side tag: `built-in`, `running`, a provider name. */
  badge?: string;
  /** A single glyph before the label. */
  icon?: string;
  /** Text that should match without being shown: a full path, a provider, an id. */
  keywords?: string;
}

/** The order sections are printed in, and the tie-break between kinds. */
const KIND_ORDER: readonly PaletteKind[] = [
  'command',
  'tab',
  'session',
  'project',
  'file',
  'model',
  'thinking',
];

const KIND_TITLES: Record<PaletteKind, string> = {
  command: 'Commands',
  tab: 'Open tabs',
  session: 'Sessions',
  project: 'Projects',
  file: 'Files',
  model: 'Models',
  thinking: 'Thinking',
};

/**
 * The leading characters that lock the palette to one source, VS Code-style.
 * The default is the flat "everything" list — the macOS Help-search shape — and
 * a prefix is only how a reader who already knows what they want narrows it.
 */
const PREFIXES: readonly { prefix: string; kind: PaletteKind }[] = [
  { prefix: '>', kind: 'command' },
  { prefix: '#', kind: 'session' },
  { prefix: '@', kind: 'file' },
  { prefix: ':', kind: 'project' },
];

export interface PaletteQuery {
  /** The source a leading prefix locked, or `undefined` for the flat list. */
  kind?: PaletteKind;
  /** What is left to match once the prefix is taken off. */
  filter: string;
}

/** Splits `> mod` into the source it locks and the words that remain. */
export function parsePaletteQuery(raw: string): PaletteQuery {
  const hit = PREFIXES.find((candidate) => raw.startsWith(candidate.prefix));
  if (hit === undefined) {
    return { filter: raw.trim() };
  }
  return { kind: hit.kind, filter: raw.slice(hit.prefix.length).trim() };
}

/**
 * Score of one entry against `needle`, lower first. A label that starts with the
 * query wins, then a word inside it, then anywhere in the label, then a
 * subsequence (`mdls` finds `Markdown`, which is what a palette is expected to
 * do), and finally a hit in the description, badge or keywords.
 */
export function scorePaletteEntry(entry: PaletteEntry, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  const label = entry.label.toLowerCase();
  if (label.startsWith(needle)) {
    return 0;
  }
  if (label.includes(` ${needle}`)) {
    return 1;
  }
  if (label.includes(needle)) {
    return 2;
  }
  const span = subsequenceSpan(needle, label);
  if (span !== undefined) {
    // A tighter span (`md` in `markdown`) beats a scattered one.
    return 3 + span;
  }
  const haystack = `${entry.description ?? ''} ${entry.badge ?? ''} ${entry.keywords ?? ''}`.toLowerCase();
  if (haystack.includes(needle)) {
    return 1_000;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * How far apart the query's characters sit when matched in order, or `undefined`
 * when they do not all appear. `0` is a contiguous run.
 */
function subsequenceSpan(needle: string, haystack: string): number | undefined {
  let cursor = -1;
  let first = -1;
  for (const char of needle) {
    const next = haystack.indexOf(char, cursor + 1);
    if (next === -1) {
      return undefined;
    }
    if (first === -1) {
      first = next;
    }
    cursor = next;
  }
  return cursor - first;
}

/** One printed section: its kind, its heading, and its already-ranked rows. */
export interface PaletteGroup {
  kind: PaletteKind;
  title: string;
  entries: PaletteEntry[];
}

/**
 * The visible list: entries bucketed by source, ranked inside each bucket, and
 * emitted in a fixed section order.
 *
 * A flat, empty query is the "what is here" view, so each source is capped hard —
 * dumping every file and model the host knows is not a palette. A query or a
 * locked source raises the cap: the reader is looking for one thing, and hiding
 * it behind a row limit is worse than a long list.
 */
export function paletteGroups(
  entries: readonly PaletteEntry[],
  rawQuery: string,
  limitPerGroup = 50,
  emptyLimit = 8,
): PaletteGroup[] {
  const { kind, filter } = parsePaletteQuery(rawQuery);
  const needle = filter.toLowerCase();
  const cap = needle.length === 0 && kind === undefined ? emptyLimit : limitPerGroup;
  const groups: PaletteGroup[] = [];
  for (const candidate of KIND_ORDER) {
    if (kind !== undefined && kind !== candidate) {
      continue;
    }
    const ranked = entries
      .filter((entry) => entry.kind === candidate)
      .map((entry) => ({ entry, score: scorePaletteEntry(entry, needle) }))
      .filter((row) => row.score < Number.POSITIVE_INFINITY)
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.entry.label.length - right.entry.label.length ||
          left.entry.label.localeCompare(right.entry.label),
      )
      .slice(0, cap)
      .map((row) => row.entry);
    if (ranked.length > 0) {
      groups.push({ kind: candidate, title: KIND_TITLES[candidate], entries: ranked });
    }
  }
  return groups;
}
