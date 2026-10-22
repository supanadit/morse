import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { WorkspaceSearchLine, WorkspaceSearchResult } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { LayoutState } from '../../state/layout-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { Pane, type PaneAction } from '../../ui/pane/pane';
import { Splitter } from '../../ui/splitter/splitter';

/** How long typing pauses before the host is asked — the search fires as you type. */
const DEBOUNCE_MS = 250;
/** How long the panel waits; a walk over a large tree may need most of this. */
const SEARCH_TIMEOUT_MS = 30_000;
/**
 * The dragged edge keeps at least this much conversation visible — the git
 * panel's rule, shared so both columns of the shell clamp the same way.
 */
const RESIZE_MIN_CHAT = 180;
/** Matches a file shows before the reader asks for the rest of them. */
const MAX_ROWS_PER_FILE = 3;
/** Files shown before the answer hands over the rest of them. */
const MAX_FILES_SHOWN = 50;

/** One highlighted run of a row's text. */
interface Segment {
  text: string;
  hit: boolean;
}

/** One matching line, drawn: its number and its pre-split segments. */
interface MatchView {
  line: number;
  segments: Segment[];
}

/** One file's group of rows, drawn: the name split from its folder for the grey. */
interface FileView {
  path: string;
  dir: string;
  name: string;
  count: number;
  /** The rows on screen — the file's first few, or all of them when it is expanded. */
  matches: MatchView[];
  /** The rows the file holds but does not show. */
  hidden: number;
  /** Where the file's first visible row sits in the panel's flat row order. */
  start: number;
}

/** One row of the answer, in the order the panel draws them. */
interface MatchRow {
  path: string;
  match: MatchView;
}

/** The answer as it is drawn: the file groups and the flat row order over them. */
interface SearchView {
  files: FileView[];
  rows: MatchRow[];
}

/**
 * An answer kept with the query that asked for it. A newer query must not
 * highlight the old answer's rows with its own word, so the two travel together.
 */
interface Searched {
  query: string;
  result: WorkspaceSearchResult;
}

/**
 * The browser host's search panel: a right-column sibling of the git panel
 * (they take turns in the same column — one region, one width), grepping the
 * viewing project's files for text and grouping the hits by file. Every hit row
 * opens the preview at its line, like the Explorer's rows do.
 *
 * The host answers with ripgrep where it is installed and a built-in walk
 * otherwise; `engine: 'node'` puts the panel's "install ripgrep" notice up,
 * which is the whole reason the result carries its engine.
 *
 * The panel is built for a thousand answers, not for one: a long answer is
 * summarised, a file shows its first few rows, and the keyboard walks the rows
 * without the mouse. A dump of a thousand lines is not a result a reader can
 * use.
 *
 * VS Code never renders this (`capabilities.searchPanel`): it has its own
 * Search view, the way it has its own Explorer and Source Control.
 */
@Component({
  selector: 'morse-search-panel',
  imports: [Pane, Splitter],
  templateUrl: './search-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './search-panel.css',
})
export class SearchPanel {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly layout = inject(LayoutState);

  protected readonly query = signal('');
  protected readonly include = signal('');
  protected readonly exclude = signal('');
  protected readonly caseSensitive = signal(false);
  /** A search is in flight; an older answer stays on screen until the new one lands. */
  protected readonly searching = signal(false);
  private readonly answer = signal<Searched | undefined>(undefined);
  protected readonly errorMessage = signal<string | undefined>(undefined);
  /** Files the reader folded by hand; everything starts expanded. */
  private readonly folded = signal<ReadonlySet<string>>(new Set());
  /** Files whose every row is shown, not only the first few. */
  private readonly expandedFiles = signal<ReadonlySet<string>>(new Set());
  /** The reader asked for the files past the first page. */
  private readonly showAllFiles = signal(false);
  /** The row the keyboard is on; `-1` is the answer's "no row yet". */
  private readonly marked = signal(-1);

  private readonly results = viewChild<ElementRef<HTMLElement>>('results');

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The answer as it is drawn. The rows are capped twice — a few per file, and
   * a page of files — because a thousand lines is a wall, not an answer; the
   * reader opens what they want.
   */
  protected readonly view = computed<SearchView>(() => {
    const found = this.answer();
    if (found === undefined) {
      return { files: [], rows: [] };
    }
    const folded = this.folded();
    const expanded = this.expandedFiles();
    const every = this.showAllFiles();
    const length = found.query.length;
    const files: FileView[] = [];
    const rows: MatchRow[] = [];
    for (const file of found.result.files) {
      if (!every && files.length >= MAX_FILES_SHOWN) {
        break;
      }
      const slash = file.path.lastIndexOf('/');
      const matches = file.lines.map((line) => ({
        line: line.line,
        segments: toSegments(line.text, line.columns, length),
      }));
      const isFolded = folded.has(file.path);
      const shown = isFolded
        ? []
        : expanded.has(file.path)
          ? matches
          : matches.slice(0, MAX_ROWS_PER_FILE);
      const start = rows.length;
      for (const match of shown) {
        rows.push({ path: file.path, match });
      }
      files.push({
        path: file.path,
        dir: slash === -1 ? '' : file.path.slice(0, slash),
        name: slash === -1 ? file.path : file.path.slice(slash + 1),
        count: file.count,
        matches: shown,
        hidden: matches.length - shown.length,
        start,
      });
    }
    return { files, rows };
  });

  /** The pane's badge: how many matches, `+` when a cap ended the search short. */
  protected readonly meta = computed<string | undefined>(() => {
    const found = this.answer();
    if (found === undefined) {
      return undefined;
    }
    return `${found.result.total}${found.result.truncated ? '+' : ''}`;
  });

  protected readonly truncated = computed(() => this.answer()?.result.truncated ?? false);
  /** The walk answered, not ripgrep: the notice that asks for ripgrep is up. */
  protected readonly fallback = computed(() => this.answer()?.result.engine === 'node');
  protected readonly isEmptyQuery = computed(() => this.query().trim().length === 0);
  /** There is an answer to summarise. */
  protected readonly hasAnswer = computed(() => this.answer() !== undefined);
  /** The summary line: matches, files, and the engine that answered. */
  protected readonly summary = computed(() => {
    const found = this.answer();
    if (found === undefined) {
      return undefined;
    }
    const files = found.result.files.length;
    return {
      matches: `${found.result.total}${found.result.truncated ? '+' : ''} matches`,
      files: `${files} ${files === 1 ? 'file' : 'files'}`,
      engine: found.result.engine === 'ripgrep' ? 'ripgrep' : 'built-in walk',
    };
  });
  /** The files past the first page, waiting for the reader to ask for them. */
  protected readonly hiddenFiles = computed(() => {
    const found = this.answer();
    if (found === undefined) {
      return 0;
    }
    return Math.max(0, found.result.files.length - this.view().files.length);
  });
  /** Every file shows all of its rows: the expand button is on. */
  protected readonly allExpanded = computed(() => {
    const files = this.view().files;
    if (files.length === 0) {
      return false;
    }
    const expanded = this.expandedFiles();
    return files.every((file) => expanded.has(file.path));
  });

  protected readonly paneActions = computed<readonly PaneAction[]>(() => [
    { id: 'refresh', label: 'Search again', run: () => this.run() },
    {
      id: 'rows',
      label: this.allExpanded() ? 'Show fewer rows' : 'Show every row',
      active: this.allExpanded(),
      run: () => this.toggleAllRows(),
    },
    { id: 'close', label: 'Hide the search panel', run: () => this.layout.setVisible('right', false) },
  ]);

  /**
   * The column's drag limit: the conversation keeps the same room the git
   * panel's edge leaves it, so switching panels never resizes by surprise.
   */
  protected readonly columnMax = (handle: HTMLElement): number => {
    const shell = handle.closest('.shell') as HTMLElement | null;
    const nav = shell?.querySelector('.nav') as HTMLElement | null;
    const shellWidth = shell?.getBoundingClientRect().width ?? window.innerWidth;
    const navWidth = this.layout.leftCollapsed()
      ? 0
      : (nav?.getBoundingClientRect().width ?? 240);
    return Math.max(320, shellWidth - navWidth - RESIZE_MIN_CHAT);
  };

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.schedule();
  }

  protected onInclude(event: Event): void {
    this.include.set((event.target as HTMLInputElement).value);
    this.schedule();
  }

  protected onExclude(event: Event): void {
    this.exclude.set((event.target as HTMLInputElement).value);
    this.schedule();
  }

  /** The `Aa` toggle: like VS Code's, it re-runs the search that is on screen. */
  protected toggleCase(): void {
    this.caseSensitive.update((on) => !on);
    this.run();
  }

  /** Enter skips the debounce — the reader is asking for *this* query now. */
  protected runNow(): void {
    this.run();
  }

  /** Down from the query box lands in the results, where the arrows work. */
  protected onQueryKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    this.results()?.nativeElement.focus();
  }

  protected isFolded(path: string): boolean {
    return this.folded().has(path);
  }

  protected toggleFile(path: string): void {
    this.folded.update((set) => {
      const next = new Set(set);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  }

  /** A file's rest: the rows the cap kept back. */
  protected expandFile(path: string): void {
    this.expandedFiles.update((set) => new Set(set).add(path));
  }

  /** Every file shows every row, or none does. */
  protected toggleAllRows(): void {
    const files = this.view().files;
    if (this.allExpanded()) {
      this.expandedFiles.set(new Set());
      return;
    }
    this.expandedFiles.set(new Set(files.map((file) => file.path)));
  }

  /** The rest of the files, past the first page. */
  protected showAll(): void {
    this.showAllFiles.set(true);
  }

  /** The row the keyboard is on, and the file it belongs to. */
  protected isMarked(index: number): boolean {
    return this.marked() === index;
  }

  /** The panel's keyboard: the arrows walk the rows, Enter opens one. */
  protected onResultsKeydown(event: KeyboardEvent): void {
    const rows = this.view().rows;
    if (rows.length === 0) {
      return;
    }
    const last = rows.length - 1;
    let next = this.marked();
    switch (event.key) {
      case 'ArrowDown':
        next = next < 0 ? 0 : Math.min(last, next + 1);
        break;
      case 'ArrowUp':
        next = next <= 0 ? 0 : next - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Enter': {
        const row = rows[Math.min(next, last)];
        if (row !== undefined) {
          this.tabs.openFile(row.path, row.match.line);
        }
        event.preventDefault();
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    this.marked.set(next);
    this.revealMarked();
  }

  /** A row was clicked: open it, and let the keyboard carry on from there. */
  protected openAt(index: number): void {
    const row = this.view().rows[index];
    if (row === undefined) {
      return;
    }
    this.marked.set(index);
    this.tabs.openFile(row.path, row.match.line);
  }

  /**
   * Nudges the marked row into view. The scroll is done by hand, because the
   * browser's own `scrollIntoView` moves the page, not just the list.
   */
  private revealMarked(): void {
    const container = this.results()?.nativeElement;
    const row = container?.querySelector('.match.marked') as HTMLElement | null;
    if (!container || !row) {
      return;
    }
    const view = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < view.top) {
      container.scrollTop -= view.top - rect.top;
    } else if (rect.bottom > view.bottom) {
      container.scrollTop += rect.bottom - view.bottom;
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), DEBOUNCE_MS);
  }

  private run(): void {
    clearTimeout(this.timer);
    const query = this.query().trim();
    const seq = ++this.seq;
    if (query.length === 0) {
      this.searching.set(false);
      this.errorMessage.set(undefined);
      this.answer.set(undefined);
      return;
    }
    this.searching.set(true);
    this.errorMessage.set(undefined);
    void this.morse
      .requestHostCommand(
        'searchWorkspace',
        {
          query,
          caseSensitive: this.caseSensitive(),
          include: splitPatterns(this.include()),
          exclude: splitPatterns(this.exclude()),
        },
        SEARCH_TIMEOUT_MS,
      )
      .then((value) => {
        if (seq !== this.seq) {
          return; // a newer query asked after this one; only it may speak
        }
        this.searching.set(false);
        const result = asSearchResult(value);
        if (result === undefined) {
          // Refused or timed out: `requestHostCommand` folds both into a miss,
          // and the reason itself is in the host's log, as with every command.
          this.errorMessage.set("The search failed — the host's log has the detail.");
          return;
        }
        this.marked.set(-1);
        this.answer.set({ query, result });
      });
  }
}

/** The include/exclude boxes: comma- or newline-separated globs, VS Code's habit. */
function splitPatterns(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The wire's answer as a result, or `undefined` if it is not one. Host command
 * data arrives as `unknown`, and a half-shaped answer would break the template
 * rather than fail one row.
 */
function asSearchResult(value: unknown): WorkspaceSearchResult | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Partial<WorkspaceSearchResult>;
  if (
    !Array.isArray(candidate.files) ||
    typeof candidate.total !== 'number' ||
    typeof candidate.truncated !== 'boolean' ||
    (candidate.engine !== 'ripgrep' && candidate.engine !== 'node')
  ) {
    return undefined;
  }
  const files = candidate.files.filter(
    (file): file is NonNullable<typeof file> =>
      typeof file === 'object' &&
      file !== null &&
      typeof (file as { path?: unknown }).path === 'string' &&
      typeof (file as { count?: unknown }).count === 'number' &&
      Array.isArray((file as { lines?: unknown }).lines) &&
      (file as { lines: unknown[] }).lines.every(isSearchLine),
  );
  if (files.length !== candidate.files.length) {
    return undefined;
  }
  return { ...candidate, files } as WorkspaceSearchResult;
}

function isSearchLine(value: unknown): value is WorkspaceSearchLine {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const line = value as Partial<WorkspaceSearchLine>;
  return (
    typeof line.line === 'number' &&
    typeof line.text === 'string' &&
    Array.isArray(line.columns) &&
    line.columns.every((column) => typeof column === 'number')
  );
}

/**
 * A row's text split into highlighted and plain runs around its match columns
 * (one-based). A windowed line may cut a match off at its edge; the slice just
 * clamps, which is what the row should draw anyway.
 */
function toSegments(text: string, columns: readonly number[], length: number): Segment[] {
  if (length <= 0 || columns.length === 0) {
    return [{ text, hit: false }];
  }
  const segments: Segment[] = [];
  let at = 0;
  for (const column of columns) {
    const start = column - 1;
    if (start < at || start >= text.length) {
      continue;
    }
    if (start > at) {
      segments.push({ text: text.slice(at, start), hit: false });
    }
    segments.push({ text: text.slice(start, Math.min(start + length, text.length)), hit: true });
    at = start + length;
    if (at >= text.length) {
      return segments;
    }
  }
  if (at < text.length) {
    segments.push({ text: text.slice(at), hit: false });
  }
  return segments;
}
