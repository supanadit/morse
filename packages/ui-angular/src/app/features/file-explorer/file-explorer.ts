import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  buildFileTree,
  fileGlyph,
  statusByPath,
  type ChangeKind,
  type FileNode,
  type TreeNode,
} from '@morse/ui-runtime';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { WorkspaceFiles } from '../../services/workspace-files.service';
import { WorkspaceFilesStore } from '../../state/workspace-files.store';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { Pane } from '../../ui/pane/pane';
import { Splitter } from '../../ui/splitter/splitter';
import { TreeList } from '../../ui/tree-list/tree-list';
import { rankFiles } from '../file-picker/file-picker';

const MIN_EXPLORER_HEIGHT = 140;

/** One row of the filtered list: a matching file and the folder it sits in. */
export interface FileMatch {
  path: string;
  name: string;
  /** The directory above the file, or `''` for one at the project root. */
  dir: string;
}

/**
 * The browser host's Explorer: the active project's files as a tree, one click
 * from a preview tab. VS Code never renders this — it has its own Explorer, and
 * the host advertises `filePreview: false`.
 *
 * The tree comes from the shared `WorkspaceFiles` listing (the same one the
 * composer's `@mention` picker uses, and the same one that polls the working
 * tree), so a file added or deleted on disk appears here without a restart. A
 * changed file also carries the git badge its working-tree status earns.
 */
@Component({
  selector: 'morse-file-explorer',
  imports: [Pane, Splitter, TreeList],
  templateUrl: './file-explorer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Folded, the pane is just its header: the dragged height must stand down, or it
    // leaves a tall empty box behind.
    '[class.folded]': 'collapsed()',
  },
  styleUrl: './file-explorer.css',
})
export class FileExplorer {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly shell = inject(ShellState);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
  private readonly rowsEl = viewChild<ElementRef<HTMLElement>>('rowsBox');

  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  private readonly folded = signal(false);
  /** The file in front, when the active tab is a file: the row the tree follows. */
  private readonly activePath = computed(() => {
    const tab = this.tabs.activeTab();
    return tab?.kind === 'file' ? tab.path : undefined;
  });
  /**
   * The row the tree highlights. It follows the active file chip — from the
   * Explorer, the git panel or the `@` picker — so switching chips moves the
   * Explorer's focus too, not just the preview.
   */
  protected readonly selected = signal<string | undefined>(undefined);
  /** The project the expanded set belongs to, so switching projects folds it. */
  private expandedFor = '';
  /**
   * The path the tree last revealed. A poll, a refresh or the reader's own
   * expand/collapse changes `rows` too, and none of them may scroll the pane
   * back to the file in front — only a *new* file in front earns a reveal.
   */
  private revealedPath: string | undefined;
  /** Set by a reveal, cleared by the single scroll it schedules. */
  private scrollPending = false;

  private readonly tree = computed(() => buildFileTree(this.workspaceStore.files()));
  /**
   * The files as the shared tree wants them: a node with a label, a kind and its
   * children, carrying the `FileNode` itself so a click opens the right path. A
   * directory keeps its fold mark; a file shows its git badge.
   */
  protected readonly nodes = computed<TreeNode<FileNode>[]>(() => this.toNodes(this.tree()));
  protected readonly fileCount = computed(() => countFiles(this.tree()));
  protected readonly collapsed = this.folded.asReadonly();
  protected readonly isLoading = this.workspaceStore.busy;
  protected readonly errorMessage = this.workspaceStore.error;
  /**
   * The Explorer's own search box. A non-empty query replaces the tree with a
   * flat list of matching files — VS Code's Explorer filter, and the fast way to
   * reach a file whose folder the reader would otherwise have to open by hand.
   */
  protected readonly filter = signal('');
  protected readonly filtering = computed(() => this.filter().trim().length > 0);
  protected readonly matching = computed(() =>
    matchFiles(this.workspaceStore.files(), this.filter()),
  );
  /**
   * The title bar counts what is on screen: the matches while filtering, every
   * file otherwise. `3 of 41` says the box is narrowing the project, not that the
   * project shrank.
   */
  protected readonly meta = computed(() =>
    this.filtering()
      ? `${this.matching().length} of ${this.fileCount()}`
      : this.fileCount().toString(),
  );

  /** The changed paths by letter, and the folders that contain one. */
  private readonly changes = computed(() => statusByPath(this.workspaceStore.status()));
  private readonly changedDirs = computed(() => {
    const dirs = new Set<string>();
    for (const path of this.changes().keys()) {
      const segments = path.split('/');
      for (let depth = 1; depth < segments.length; depth += 1) {
        dirs.add(segments.slice(0, depth).join('/'));
      }
    }
    return dirs;
  });

  constructor() {
    effect(() => {
      const cwd = this.morse.state().workspace.cwd;
      untracked(() => {
        // `state()` re-emits on every transcript update; only a new project
        // deserves a fresh expanded set.
        if (cwd.length > 0 && cwd !== this.expandedFor) {
          this.expanded.set(new Set());
          this.revealedPath = undefined;
          this.expandedFor = cwd;
          // A query for the last project's files would leave this one looking empty.
          this.filter.set('');
        }
      });
    });

    // Follow the file in front: open its folders and mark its row — but only the
    // first time it comes forward. Reading the file list as well means a file
    // opened before the tree loaded still gets revealed when the list arrives.
    effect(() => {
      const path = this.activePath();
      const files = this.workspaceStore.files();
      untracked(() => {
        if (path === this.revealedPath) {
          return;
        }
        if (this.revealActive(path, files)) {
          this.revealedPath = path;
          this.scrollPending = true;
        } else {
          // Not ours (or not listed yet): forget it, so a later poll can reveal
          // the path once the project answers with it.
          this.revealedPath = undefined;
        }
      });
    });

    // Bring the marked row into view once it has rendered: the reveal above
    // expands folders, which changes `rows`, so this runs after the tree grew.
    // Only a pending reveal may scroll — a poll or the reader's own
    // expand/collapse changes `rows` too, and must leave the pane where it is.
    effect(() => {
      this.nodes();
      this.selected();
      this.collapsed();
      untracked(() => {
        if (!this.scrollPending) {
          return;
        }
        this.scrollPending = false;
        setTimeout(() => this.revealSelected(), 0);
      });
    });
  }

  /**
   * Opens every folder on the way to `path` and marks its row, reporting whether
   * the active project lists it. A path the active project does not list is
   * ignored, so a file chip belonging to another project does not expand a tree
   * that cannot contain it.
   */
  private revealActive(path: string | undefined, files: readonly string[]): boolean {
    if (path === undefined || !files.includes(path)) {
      this.selected.set(undefined);
      return false;
    }
    this.selected.set(path);
    const ancestors = ancestorsOf(path);
    if (ancestors.length === 0) {
      return true;
    }
    this.expanded.update((set) => {
      const next = new Set(set);
      let changed = false;
      for (const dir of ancestors) {
        if (!next.has(dir)) {
          next.add(dir);
          changed = true;
        }
      }
      return changed ? next : set;
    });
    return true;
  }

  /** Scrolls the highlighted row into the pane's viewport, VS Code's behaviour. */
  private revealSelected(): void {
    const container = this.rowsEl()?.nativeElement;
    const row = container?.querySelector<HTMLElement>('.row.active');
    if (container === undefined || row === null || row === undefined) {
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

  /**
   * The tree the shared component draws: every `FileNode` paired with a node that
   * says what to show. A folder carries a dot when it holds a change, a file its
   * git badge — the badges the Explorer used to draw in its own template.
   */
  private toNodes(nodes: readonly FileNode[]): TreeNode<FileNode>[] {
    return nodes.map((node) => ({
      id: node.path,
      label: node.name,
      data: node,
      badge: this.badgeFor(node),
      badgeTone: this.toneFor(node),
      kind: node.kind === 'dir' ? ('group' as const) : ('leaf' as const),
      children: node.kind === 'dir' ? this.toNodes(node.children) : [],
    }));
  }

  /** The mark a file's row ends with: a git letter, or a dot for a folder that holds one. */
  private badgeFor(node: FileNode): string | undefined {
    if (node.kind === 'file') {
      return this.changeOf(node.path);
    }
    return this.dirChanged(node.path) ? '•' : undefined;
  }

  /**
   * The colour that letter earns. The mapping is the Explorer's, not the tree's: a
   * modified file warns, an added one succeeds, a deleted or conflicted one errs.
   */
  private toneFor(node: FileNode): TreeNode<FileNode>['badgeTone'] {
    if (node.kind === 'dir') {
      return 'warn';
    }
    switch (this.changeOf(node.path)) {
      case 'M':
        return 'warn';
      case 'A':
      case 'U':
        return 'success';
      case 'D':
      case 'C':
        return 'error';
      case 'R':
        return 'info';
      default:
        return 'plain';
    }
  }

  protected glyphFor = fileGlyph;

  /** The shared tree reports the node it was given; a folder folds, a file opens. */
  protected onTreeRow(node: TreeNode<FileNode>): void {
    this.onRow(node.data);
  }

  /** The git badge letter for a file, or `undefined` when it is unchanged. */
  protected changeOf(path: string): ChangeKind | undefined {
    return this.changes().get(path);
  }

  protected badgeTitle(change: ChangeKind): string {
    switch (change) {
      case 'M':
        return 'Modified';
      case 'A':
        return 'Added';
      case 'D':
        return 'Deleted';
      case 'R':
        return 'Renamed';
      case 'U':
        return 'Untracked';
      case 'C':
        return 'Conflict';
    }
  }

  protected dirChanged(path: string): boolean {
    return this.changedDirs().has(path);
  }

  protected toggleFold(): void {
    this.folded.update((value) => !value);
  }

  protected refresh(): void {
    this.workspace.refresh();
  }

  protected onRow(node: FileNode): void {
    if (node.kind === 'dir') {
      this.expanded.update((set) => {
        const next = new Set(set);
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
      return;
    }
    this.tabs.openFile(node.path);
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  /** Escape empties the box, and stops there: nothing else is up to close. */
  protected onFilterKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || this.filter().length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.filter.set('');
  }

  protected openMatch(match: FileMatch): void {
    this.tabs.openFile(match.path);
  }

  /** The list above gives way, but never below a screenful of it. */
  protected readonly explorerMax = (handle: HTMLElement): number => {
    const box = handle.parentElement;
    if (box === null) {
      return Number.POSITIVE_INFINITY;
    }
    const bottom = box.getBoundingClientRect().bottom;
    const top = box.parentElement?.getBoundingClientRect().top ?? 0;
    return Math.max(MIN_EXPLORER_HEIGHT, bottom - top - 120);
  };
}

/**
 * The files whose path matches the filter, best first — the flat list an open
 * search box shows instead of the tree.
 *
 * Directories are left out: the filtered view answers "find a file", and a folder
 * row would only open a folder. The ranking is the `@mention` picker's, through
 * `rankFiles`, so the two file lists look for the same thing the same way.
 */
export function matchFiles(files: readonly string[], query: string): FileMatch[] {
  if (query.trim().length === 0) {
    return [];
  }
  return rankFiles(files, query, Number.POSITIVE_INFINITY)
    .filter((path) => !path.endsWith('/'))
    .map((path) => {
      const cut = path.lastIndexOf('/');
      return {
        path,
        name: cut === -1 ? path : path.slice(cut + 1),
        dir: cut === -1 ? '' : path.slice(0, cut),
      };
    });
}

function countFiles(nodes: readonly FileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += node.kind === 'file' ? 1 : countFiles(node.children);
  }
  return count;
}

/** Every directory above `path`, outermost first (`a/b/c.ts` -> `a`, `a/b`). */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  const ancestors: string[] = [];
  for (let depth = 1; depth < parts.length; depth += 1) {
    ancestors.push(parts.slice(0, depth).join('/'));
  }
  return ancestors;
}
