import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import type { WorkspaceSearchLine, WorkspaceSearchResult } from '@morse/protocol';
import { highlightCode, languageForPath } from '@morse/ui-runtime';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { Dialog } from '../../ui/dialog/dialog';

/** How long typing pauses before the host is asked — the search fires as you type. */
const DEBOUNCE_MS = 250;
/** How long the dialog waits; a walk over a large tree may need most of this. */
const SEARCH_TIMEOUT_MS = 30_000;
/** The preview keeps to this many lines; the host may hand back a large file. */
const MAX_PREVIEW_LINES = 4000;
/** Rows the flat list shows before the reader asks for the rest. */
const MAX_ROWS = 500;
/** One highlighted run of a row's text. */
interface Segment {
  text: string;
  hit: boolean;
}

/** One row of the flat answer: the matched line, its file named at the end. */
interface MatchRow {
  path: string;
  name: string;
  line: number;
  segments: Segment[];
}

/** The answer as it is drawn: the flat rows and the files behind them. */
interface SearchView {
  rows: MatchRow[];
  /** The still-unshown rows, when the display cap cut the list short. */
  hiddenRows: number;
  /** Per-file matched lines, keyed for the preview's highlights. */
  matched: Map<string, WorkspaceSearchLine[]>;
}

/**
 * An answer kept with the query that asked for it — and the project it was
 * asked in, because a Module-tab answer's paths are read from that project.
 */
interface Searched {
  query: string;
  cwd: string | undefined;
  result: WorkspaceSearchResult;
}

/** One preview line: its number and its syntax-highlighted, match-marked HTML. */
interface PreviewLine {
  line: number;
  html: SafeHtml;
}

/** The file under the marked row, read and laid out for the preview pane. */
interface PreviewFile {
  path: string;
  name: string;
  dir: string;
  lines: PreviewLine[];
  cut: boolean;
  /** The query whose highlights the lines carry, so a new query repaints them. */
  queryLength: number;
}

/** The four tabs under the search field, in the editor's standard order. */
type FindTab = 'project' | 'module' | 'directory' | 'scope';

/** The scope menu's entries. */
type FindScope = 'project' | 'production' | 'test' | 'open';

/** Globs that stand for tests, for the Production/Test scope pair. */
const TEST_GLOBS = ['**/*.spec.*', '**/*.test.*', '**/*_test.*'];
/** The file-mask combo's suggestions: a short list of common masks. */
const MASK_SUGGESTIONS = ['*.ts', '*.js', '*.json', '*.md'];

/**
 * Find in Files: a fixed-size modal popup over the app whose titlebar carries
 * the match count, the file mask and the pin; the search field with its toggles;
 * the In Project / Module / Directory / Scope tabs; a flat match list with the
 * file named at each row's end; and a preview pane that reads the selected file
 * whole — syntax-highlighted, every match painted, the selection's line banded.
 *
 * The engine answers fixed strings only, so the words and regex toggles are
 * shown greyed with an explanation rather than as dead switches that lie.
 *
 * Enter opens the marked match: with "Open results in new tab" (or the pin,
 * which is the same switch) the dialog stays up as the find window; without it,
 * jumping to the source closes it. Ctrl+Enter always keeps the dialog open.
 *
 * VS Code never renders this (`capabilities.searchPanel`): it has its own
 * Search view, the way it has its own Explorer and Source Control.
 */
@Component({
  selector: 'morse-search-panel',
  imports: [Dialog],
  templateUrl: './search-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './search-panel.css',
})
export class SearchPanel {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly shell = inject(ShellState);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly query = signal('');
  protected readonly caseSensitive = signal(false);
  protected readonly fileMask = signal('');
  protected readonly maskOn = signal(false);
  protected readonly exclude = signal('');
  protected readonly excludeOpen = signal(false);
  protected readonly tab = signal<FindTab>('project');
  protected readonly scope = signal<FindScope>('project');
  protected readonly directory = signal('');
  /** The Module tab's project (its directory path), pre-set to the one in front. */
  protected readonly modulePath = signal(this.morse.state().workspace?.cwd ?? '');
  /** "Open results in new tab" and the titlebar's pin are one switch. */
  protected readonly stayOpen = signal(false);
  protected readonly maskMenuOpen = signal(false);
  protected readonly projectMenuOpen = signal(false);
  protected readonly scopeMenuOpen = signal(false);

  /** A search is in flight; an older answer stays on screen until the new one lands. */
  protected readonly searching = signal(false);
  private readonly answer = signal<Searched | undefined>(undefined);
  protected readonly errorMessage = signal<string | undefined>(undefined);
  /** The row the keyboard is on; `-1` is the answer's "no row yet". */
  private readonly marked = signal(-1);
  /** The reader asked for the rows past the first page. */
  private readonly showAllRows = signal(false);

  /** The file under the marked row, read for the preview pane. */
  private readonly previewFile = signal<PreviewFile | undefined>(undefined);
  protected readonly preview = this.previewFile.asReadonly();
  private readonly previewLoading = signal(false);
  private previewSeq = 0;

  private readonly results = viewChild<ElementRef<HTMLElement>>('results');
  private readonly previewEl = viewChild<ElementRef<HTMLElement>>('previewPane');

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly maskSuggestions = MASK_SUGGESTIONS;

  /** The projects the Module tab can narrow to, named for its menu. */
  protected readonly projects = computed(() => this.morse.projects());
  protected readonly moduleName = computed(() => {
    const path = this.modulePath();
    return this.projects().find((project) => project.path === path)?.name ?? 'Project';
  });

  protected readonly scopeLabels: readonly { id: FindScope; label: string }[] = [
    { id: 'project', label: 'Project Files' },
    { id: 'production', label: 'Project Production Files' },
    { id: 'test', label: 'Project Test Files' },
    { id: 'open', label: 'Open Files' },
  ];
  protected readonly scopeLabel = computed(
    () => this.scopeLabels.find((entry) => entry.id === this.scope())?.label ?? 'Project Files',
  );

  /** The globs the current tab and mask boil down to, sent with every search. */
  private readonly patterns = computed(() => {
    const include: string[] = [];
    const exclude = splitPatterns(this.exclude());
    if (this.tab() === 'directory') {
      const dir = this.directory().trim().replace(/^\.?\//, '').replace(/\/+$/, '');
      if (dir.length > 0) {
        include.push(`${dir}/**`);
      }
    }
    const mask = this.fileMask().trim();
    if (this.maskOn() && mask.length > 0) {
      include.push(mask);
    }
    if (this.scope() === 'test') {
      include.push(...TEST_GLOBS);
    }
    if (this.scope() === 'production') {
      exclude.push(...TEST_GLOBS);
    }
    return { include, exclude };
  });

  /**
   * The answer as it is drawn: a flat row per match, the file named at the row's
   * end. The Open Files scope narrows the answer to the tab strip's file tabs
   * here, where the host has no notion of them.
   */
  protected readonly view = computed<SearchView>(() => {
    const found = this.answer();
    if (found === undefined) {
      return { rows: [], hiddenRows: 0, matched: new Map() };
    }
    const length = found.query.length;
    const openOnly = this.scope() === 'open';
    const openPaths = openOnly
      ? new Set(
          this.tabs
            .tabs()
            .filter((entry) => entry.kind === 'file')
            .map((entry) => entry.path),
        )
      : undefined;
    const rows: MatchRow[] = [];
    const matched = new Map<string, WorkspaceSearchLine[]>();
    let hiddenRows = 0;
    for (const file of found.result.files) {
      if (openPaths !== undefined && !openPaths.has(file.path)) {
        continue;
      }
      const slash = file.path.lastIndexOf('/');
      matched.set(file.path, file.lines);
      for (const line of file.lines) {
        if (!this.showAllRows() && rows.length >= MAX_ROWS) {
          hiddenRows += 1;
          continue;
        }
        rows.push({
          path: file.path,
          name: slash === -1 ? file.path : file.path.slice(slash + 1),
          line: line.line,
          segments: toSegments(line.text, line.columns, length),
        });
      }
    }
    return { rows, hiddenRows, matched };
  });

  /** The titlebar's count, in the editor's grammar: `828 matches in 75 files`. */
  protected readonly summary = computed(() => {
    const found = this.answer();
    if (found === undefined) {
      return undefined;
    }
    return `${found.result.total}${found.result.truncated ? '+' : ''} matches in ${found.result.files.length} ${found.result.files.length === 1 ? 'file' : 'files'}`;
  });

  /** The walk answered, not ripgrep: the notice that asks for ripgrep is up. */
  protected readonly fallback = computed(() => this.answer()?.result.engine === 'node');
  protected readonly truncated = computed(() => this.answer()?.result.truncated ?? false);
  protected readonly isEmptyQuery = computed(() => this.query().trim().length === 0);
  protected readonly noMatches = computed(() => this.answer() !== undefined && this.view().rows.length === 0);
  /**
   * The empty state hides the preview pane while there is nothing to show in it — the
   * empty query, a search in flight, or an answer with no rows — and lets the
   * hint span the whole dialog instead.
   */
  protected readonly listSolo = computed(
    () => this.view().rows.length === 0 && this.preview() === undefined && !this.previewLoading(),
  );

  /** The preview's small count, next to the file name. */
  protected readonly previewMeta = computed(() => {
    const file = this.previewFile();
    if (file === undefined) {
      return undefined;
    }
    const hits = this.view().matched.get(file.path)?.length ?? 0;
    return `${hits} ${hits === 1 ? 'match' : 'matches'}`;
  });

  constructor() {
    // The selection decides the preview: a new file is read, the same file only
    // has its rows repainted around the moved highlight.
    effect(() => {
      const row = this.markedRow();
      const path = row?.path;
      if (path === undefined) {
        this.previewSeq++;
        this.previewFile.set(undefined);
        this.previewLoading.set(false);
        return;
      }
      const current = this.previewFile();
      const queryLength = this.answer()?.query.length ?? 0;
      if (current?.path === path && current.queryLength === queryLength) {
        return;
      }
      void this.loadPreview(path, this.answer()?.cwd);
    });
    // The highlighted row follows the keyboard into the preview's view, by hand —
    // the browser's own `scrollIntoView` moves the page, not just the pane.
    effect(() => {
      const row = this.markedRow();
      const file = this.previewFile();
      if (file === undefined || row === undefined) {
        return;
      }
      queueMicrotask(() => this.revealPreviewLine(row.line));
    });
    // A menu closes when the tab under it changes: the control it belongs to is
    // gone from the row.
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  /** The row the keyboard is on, or `undefined` before the first answer. */
  private markedRow(): MatchRow | undefined {
    const rows = this.view().rows;
    const index = this.marked();
    return index >= 0 ? rows[Math.min(index, rows.length - 1)] : undefined;
  }

  /** The backdrop or Escape: leave without opening anything. */
  protected close(): void {
    this.shell.closeFindFiles();
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.schedule();
  }

  protected onMask(event: Event): void {
    this.fileMask.set((event.target as HTMLInputElement).value);
    this.schedule();
  }

  protected toggleMask(): void {
    this.maskOn.update((on) => !on);
    this.run();
  }

  protected onExclude(event: Event): void {
    this.exclude.set((event.target as HTMLInputElement).value);
    this.schedule();
  }

  protected onDirectory(event: Event): void {
    this.directory.set((event.target as HTMLInputElement).value);
    this.schedule();
  }

  /** The funnel: the exclude box is folded away until it is wanted. */
  protected toggleExclude(): void {
    this.excludeOpen.update((open) => !open);
  }

  /** The pin and the footer checkbox are one state; either may flip it. */
  protected toggleStay(): void {
    this.stayOpen.update((on) => !on);
  }

  protected setTab(tab: FindTab): void {
    if (this.tab() === tab) {
      return;
    }
    this.maskMenuOpen.set(false);
    this.projectMenuOpen.set(false);
    this.scopeMenuOpen.set(false);
    this.tab.set(tab);
    this.run();
  }

  protected setScope(scope: FindScope): void {
    this.scope.set(scope);
    this.scopeMenuOpen.set(false);
    this.run();
  }

  protected setModule(path: string): void {
    this.modulePath.set(path);
    this.projectMenuOpen.set(false);
    this.run();
  }

  /** The `Aa` toggle: like VS Code's, it re-runs the search that is on screen. */
  protected toggleCase(): void {
    this.caseSensitive.update((on) => !on);
    this.run();
  }

  /** Clears the field and the answer, the `×` in the search row. */
  protected clearQuery(): void {
    this.query.set('');
    this.run();
  }

  /**
   * The query box keeps the keyboard while it is focused — the dialog
   * lets the arrows walk the matches from the field. Enter opens the marked
   * match; Ctrl+Enter opens it and keeps the dialog up regardless of the pin.
   */
  protected onQueryKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveMarked(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        this.openMarked({ keepOpen: true });
      } else {
        this.openMarked();
      }
    }
  }

  /** The arrows walk the rows, Enter opens one — same grammar, from the list. */
  protected onResultsKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveMarked(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveMarked(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.jumpMarked(0);
        break;
      case 'End':
        event.preventDefault();
        this.jumpMarked(this.view().rows.length - 1);
        break;
      case 'Enter':
        event.preventDefault();
        this.openMarked({ keepOpen: event.ctrlKey || event.metaKey });
        break;
      default:
        break;
    }
  }

  protected isMarked(index: number): boolean {
    return this.marked() === index;
  }

  /** Whether a preview line is the one the marked row points at. */
  protected isMarkedCurrentPreviewLine(line: number): boolean {
    return this.markedRow()?.line === line;
  }

  private moveMarked(delta: number): void {
    const rows = this.view().rows;
    if (rows.length === 0) {
      return;
    }
    const last = rows.length - 1;
    const current = this.marked();
    const next = current < 0 ? 0 : Math.min(last, Math.max(0, current + delta));
    this.marked.set(next);
    this.revealMarked();
  }

  private jumpMarked(index: number): void {
    if (this.view().rows.length === 0) {
      return;
    }
    this.marked.set(Math.max(0, index));
    this.revealMarked();
  }

  /**
   * Opens the marked match in a tab at its line. With the pin on (or on
   * Ctrl+Enter) the dialog stays up — the find window keeps its results.
   */
  private openMarked({ keepOpen } : { keepOpen?: boolean } = {}): void {
    const row = this.markedRow() ?? this.view().rows[0];
    if (row === undefined) {
      return;
    }
    this.tabs.openFile(row.path, row.line);
    if (keepOpen || this.stayOpen()) {
      this.revealMarked();
    } else {
      this.close();
    }
  }

  /** The footer's button: open the marked match, keep the find window up. */
  protected openInFindWindow(): void {
    this.openMarked({ keepOpen: true });
  }

  /** A row was clicked: mark it (the preview follows), and open it. */
  protected openAt(index: number): void {
    const row = this.view().rows[index];
    if (row === undefined) {
      return;
    }
    this.marked.set(index);
    this.tabs.openFile(row.path, row.line);
    if (!this.stayOpen()) {
      this.close();
    }
  }

  /** The rows past the first page, once the reader asks for them. */
  protected showRest(): void {
    this.showAllRows.set(true);
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

  /** Brings the preview's highlighted line into its pane's view. */
  private revealPreviewLine(line: number): void {
    const container = this.previewEl()?.nativeElement;
    if (!container) {
      return;
    }
    const row = container.querySelector('.preview-line.current') as HTMLElement | null;
    if (!row) {
      return;
    }
    const view = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < view.top || rect.bottom > view.bottom) {
      container.scrollTop += rect.top - view.top - view.height / 2 + rect.height / 2;
    }
  }

  /** Reads the file under the selection for the preview pane. */
  private async loadPreview(path: string, cwd: string | undefined): Promise<void> {
    const seq = ++this.previewSeq;
    const queryLength = this.answer()?.query.length ?? 0;
    const matched = this.view().matched.get(path) ?? [];
    const language = languageForPath(path) ?? '';
    this.previewLoading.set(true);
    const data = await this.morse
      .requestHostCommand('readFile', cwd === undefined ? { path } : { path, cwd })
      .catch(() => undefined);
    if (seq !== this.previewSeq) {
      return; // the keyboard moved on; only the newest ask may speak
    }
    this.previewLoading.set(false);
    this.previewFile.set(
      asPreviewFile(data, path, language, queryLength, matched, (html) =>
        this.sanitizer.bypassSecurityTrustHtml(html),
      ),
    );
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), DEBOUNCE_MS);
  }

  protected run(): void {
    clearTimeout(this.timer);
    const query = this.query().trim();
    const seq = ++this.seq;
    if (query.length === 0) {
      this.searching.set(false);
      this.errorMessage.set(undefined);
      this.answer.set(undefined);
      this.previewSeq++;
      this.previewFile.set(undefined);
      return;
    }
    this.searching.set(true);
    this.errorMessage.set(undefined);
    const moduleCwd = this.tab() === 'module' ? this.modulePath() : undefined;
    void this.morse
      .requestHostCommand(
        'searchWorkspace',
        {
          query,
          caseSensitive: this.caseSensitive(),
          include: this.patterns().include,
          exclude: this.patterns().exclude,
          ...(moduleCwd !== undefined && moduleCwd.length > 0 ? { cwd: moduleCwd } : {}),
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
        this.marked.set(result.files.length > 0 ? 0 : -1);
        this.answer.set({ query, result, cwd: moduleCwd });
      });
  }
}

/** The exclude box: comma- or newline-separated globs, VS Code's habit. */
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
 * The `readFile` answer as the preview's file, or `undefined` if it is not one.
 * Each line is syntax-highlighted for its language, then the query's match
 * ranges are wrapped as `<span class="hit">` over the highlighted HTML — by
 * walking the DOM's text nodes, whose concatenation is the line's plain text,
 * so a match keeps its colours and its highlight in one pass.
 */
function asPreviewFile(
  value: unknown,
  path: string,
  language: string,
  queryLength: number,
  matched: readonly WorkspaceSearchLine[],
  trust: (html: string) => SafeHtml,
): PreviewFile | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const content = candidate['content'];
  if (typeof content !== 'string' || candidate['binary'] === true) {
    return undefined;
  }
  const byLine = new Map<number, WorkspaceSearchLine>();
  for (const line of matched) {
    byLine.set(line.line, line);
  }
  const split = (content as string).split('\n');
  const cut = split.length > MAX_PREVIEW_LINES;
  const slash = path.lastIndexOf('/');
  const lines: PreviewLine[] = split.slice(0, MAX_PREVIEW_LINES).map((text, index) => {
    const found = byLine.get(index + 1);
    const html = highlightLine(text, language, found?.columns ?? [], queryLength);
    return { line: index + 1, html: trust(html) };
  });
  return {
    path,
    name: slash === -1 ? path : path.slice(slash + 1),
    dir: slash === -1 ? '' : path.slice(0, slash),
    lines,
    cut,
    queryLength,
  };
}

/** One line's HTML: syntax-highlighted, with the match ranges marked over it. */
function highlightLine(
  text: string,
  language: string,
  columns: readonly number[],
  length: number,
): string {
  const html = highlightCode(text, language).html;
  if (length <= 0 || columns.length === 0) {
    return html;
  }
  const ranges = [...columns]
    .sort((a, b) => a - b)
    .map((column) => ({ start: column - 1, end: column - 1 + length }));
  return wrapRanges(html, ranges);
}

/**
 * Wraps character ranges of the plain text behind an HTML fragment in
 * `<span class="hit">`. Text nodes concatenate to the fragment's plain text,
 * so a walk in document order tracks the offset, and ranges that span node
 * boundaries (a match crossing a syntax token) are wrapped in both.
 */
function wrapRanges(html: string, ranges: readonly { start: number; end: number }[]): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(
      `<body><div id="wrap-ranges-root">${html}</div></body>`,
      'text/html',
    );
  } catch {
    return html; // no DOM (an odd embedding); the line shows unmarked
  }
  const root = doc.getElementById('wrap-ranges-root');
  if (root === null) {
    return html;
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  type Edit = { node: Text; start: number; end: number };
  const edits: Edit[] = [];
  let offset = 0;
  let rangeIndex = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nodeStart = offset;
    const nodeEnd = offset + node.data.length;
    while (rangeIndex < ranges.length) {
      const range = ranges[rangeIndex]!;
      if (range.end <= nodeStart) {
        rangeIndex++; // this match ended before the node began
        continue;
      }
      if (range.start >= nodeEnd) {
        break; // this match starts after the node ends
      }
      edits.push({
        node,
        start: Math.max(range.start, nodeStart) - nodeStart,
        end: Math.min(range.end, nodeEnd) - nodeStart,
      });
      if (range.end <= nodeEnd) {
        rangeIndex++; // the whole match sat in this node
      } else {
        break; // the match continues into the next node
      }
    }
    offset = nodeEnd;
  }
  // Later edits first: splitting a node does not move an earlier range's
  // coordinates within it.
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    const mark = doc.createElement('span');
    mark.className = 'hit';
    const end = edit.node.splitText(edit.end);
    const middle = edit.node.splitText(edit.start);
    middle.parentNode!.insertBefore(mark, end);
    mark.appendChild(middle);
  }
  return root.innerHTML;
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
