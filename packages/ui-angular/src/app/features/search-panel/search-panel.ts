import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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
  matches: MatchView[];
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

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly files = computed<FileView[]>(() => {
    const found = this.answer();
    if (found === undefined) {
      return [];
    }
    const length = found.query.length;
    return found.result.files.map((file) => {
      const slash = file.path.lastIndexOf('/');
      return {
        path: file.path,
        dir: slash === -1 ? '' : file.path.slice(0, slash),
        name: slash === -1 ? file.path : file.path.slice(slash + 1),
        count: file.count,
        matches: file.lines.map((line) => ({
          line: line.line,
          segments: toSegments(line.text, line.columns, length),
        })),
      };
    });
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

  protected readonly paneActions = computed<readonly PaneAction[]>(() => [
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

  protected open(file: FileView, match: MatchView): void {
    this.tabs.openFile(file.path, match.line);
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
