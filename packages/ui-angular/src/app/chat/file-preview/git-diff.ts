/** One parsed line of a unified diff. */
export interface DiffRow {
  kind: 'context' | 'add' | 'del';
  text: string;
  /** Line number in the old file (absent for an addition). */
  oldLine?: number;
  /** Line number in the new file (absent for a deletion). */
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  rows: DiffRow[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Git said the file is binary instead of printing a textual diff. */
  binary: boolean;
}

/** A row for the unified view: a hunk header or a diff line. */
export type UnifiedRow = DiffRow | { kind: 'hunk'; text: string };

/** A row for the side-by-side view; a hunk header spans both sides. */
export interface SplitRow {
  hunk?: string;
  left?: DiffRow;
  right?: DiffRow;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses the output of `git diff` (unified). File headers (`diff --git`, …) are
 * dropped — the preview already knows the path — and each hunk keeps its line
 * numbers so the two diff modes can show a gutter.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  let binary = false;

  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  for (const line of lines) {
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      current = { header: line, rows: [] };
      hunks.push(current);
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    if (current === undefined) {
      // `diff --git`, `index`, `---`, `+++`: not shown.
      continue;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" annotates the previous row; ignore it.
      continue;
    }
    const sign = line.charAt(0);
    const body = line.slice(1);
    if (sign === '+') {
      current.rows.push({ kind: 'add', text: body, newLine });
      newLine += 1;
      additions += 1;
    } else if (sign === '-') {
      current.rows.push({ kind: 'del', text: body, oldLine });
      oldLine += 1;
      deletions += 1;
    } else if (sign === ' ') {
      current.rows.push({ kind: 'context', text: body, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return { hunks, additions, deletions, binary };
}

/** Flattens the hunks into the rows a unified view draws top to bottom. */
export function unifiedRows(parsed: ParsedDiff): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const hunk of parsed.hunks) {
    rows.push({ kind: 'hunk', text: hunk.header });
    rows.push(...hunk.rows);
  }
  return rows;
}

/**
 * Pairs the deletions and additions of each change block so an old and a new
 * line sit side by side. A block with more lines on one side pads the other, and
 * context lines appear on both sides unchanged.
 */
export function splitRows(parsed: ParsedDiff): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const hunk of parsed.hunks) {
    rows.push({ hunk: hunk.header });
    let index = 0;
    while (index < hunk.rows.length) {
      const row = hunk.rows[index]!;
      if (row.kind === 'context') {
        rows.push({ left: row, right: row });
        index += 1;
        continue;
      }
      const deletions: DiffRow[] = [];
      const additions: DiffRow[] = [];
      while (index < hunk.rows.length && hunk.rows[index]!.kind === 'del') {
        deletions.push(hunk.rows[index]!);
        index += 1;
      }
      while (index < hunk.rows.length && hunk.rows[index]!.kind === 'add') {
        additions.push(hunk.rows[index]!);
        index += 1;
      }
      const count = Math.max(deletions.length, additions.length);
      for (let pair = 0; pair < count; pair += 1) {
        rows.push({ left: deletions[pair], right: additions[pair] });
      }
    }
  }
  return rows;
}

/**
 * The diff a preview shows for a file with no changes against HEAD: an untracked
 * file has none, so every line of its content reads as added. `path` only keeps
 * the hunks' shape honest, not the file headers (the preview hides them).
 */
export function addedFileDiff(content: string): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const body = lines.map((line) => `+${line}`).join('\n');
  const header = `@@ -0,0 +1,${lines.length} @@`;
  return `${header}\n${body}${body.length === 0 ? '' : '\n'}`;
}
