import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { buildFileTree, fileGlyph, type FileNode } from '../../core/file-tree';
import { statusByPath, type ChangeKind } from '../../core/git-status';
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';
import { WorkspaceFiles } from '../../core/workspace-files';
import { WorkspaceTabs } from '../../core/workspace-tabs';

const MIN_EXPLORER_HEIGHT = 140;

interface ExplorerRow {
  node: FileNode;
  depth: number;
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
  templateUrl: './file-explorer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // A dragged height replaces the default `max-height`; no height means the
    // CSS default stands. Folded, the pane is just its header, so the dragged
    // height must stand down — otherwise it leaves a tall empty box behind.
    '[class.sized]': 'height() !== undefined && !collapsed()',
    '[style.height.px]': 'collapsed() ? null : height()',
  },
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: none;
        position: relative;
        min-height: 0;
        max-height: 42vh;
        border-top: 1px solid var(--morse-border);
      }
      :host(.sized) {
        max-height: none;
      }
      /* The top edge is the drag handle, VS Code's panel border. */
      .resize {
        position: absolute;
        top: -3px;
        left: 0;
        right: 0;
        height: 7px;
        z-index: 2;
        cursor: ns-resize;
      }
      .resize:hover {
        background: color-mix(in srgb, var(--morse-accent) 60%, transparent);
      }
      .pane-head {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: none;
        padding: 8px 10px 6px;
      }
      .pane-toggle {
        display: flex;
        align-items: center;
        gap: 5px;
        flex: 1;
        min-width: 0;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        cursor: pointer;
      }
      .pane-toggle:hover:not(:disabled) {
        background: var(--morse-hover);
        border-radius: var(--morse-radius-sm);
      }
      .pane-title {
        font-size: 10.5px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
      }
      .pane-count {
        font-size: 10.5px;
        color: var(--morse-fg-muted);
      }
      .chevron {
        flex: none;
        display: inline-block;
        color: var(--morse-fg-muted);
        transition: transform 120ms ease;
      }
      .chevron.open {
        transform: rotate(90deg);
      }
      .icon {
        flex: none;
        width: 22px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: none;
        color: var(--morse-fg-muted);
        cursor: pointer;
      }
      .icon:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .rows {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 0 6px 8px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 2px 6px;
        border: 0;
        border-radius: 6px;
        background: none;
        color: var(--morse-fg);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .row:hover:not(:disabled),
      .row:focus-visible:not(:disabled) {
        background: var(--morse-hover);
      }
      .glyph {
        flex: none;
        width: 13px;
        text-align: center;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      .row.dir .name {
        font-weight: 600;
      }
      /* The git badge: one letter, coloured by the kind of change, VS Code's way. */
      .badge {
        flex: none;
        padding: 0 4px;
        border-radius: 4px;
        font-family: var(--morse-font-mono);
        font-size: 9.5px;
        line-height: 15px;
        color: var(--morse-fg-muted);
      }
      .badge.M {
        color: var(--morse-warn);
      }
      .badge.A,
      .badge.U {
        color: var(--morse-success);
      }
      .badge.D,
      .badge.C {
        color: var(--morse-error);
      }
      .badge.R {
        color: var(--morse-info);
      }
      /* A folder that holds a change gets a dot, so a collapsed tree still shows it. */
      .dot {
        flex: none;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--morse-warn);
      }
      .hint {
        padding: 4px 12px 10px;
        font-size: 11.5px;
        color: var(--morse-fg-muted);
      }
      .hint.error {
        color: var(--morse-warn);
      }
    `,
  ],
})
export class FileExplorer {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly shell = inject(ShellState);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The persisted pane height, `undefined` while the CSS default applies. */
  protected readonly height = this.shell.explorerHeight;

  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  private readonly folded = signal(false);
  /** The project the expanded set belongs to, so switching projects folds it. */
  private expandedFor = '';

  private readonly tree = computed(() => buildFileTree(this.workspace.files()));
  protected readonly rows = computed(() => flatten(this.tree(), this.expanded()));
  protected readonly fileCount = computed(() => countFiles(this.tree()));
  protected readonly collapsed = this.folded.asReadonly();
  protected readonly isLoading = this.workspace.busy;
  protected readonly errorMessage = this.workspace.error;

  /** The changed paths by letter, and the folders that contain one. */
  private readonly changes = computed(() => statusByPath(this.workspace.status()));
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
          this.expandedFor = cwd;
        }
      });
    });
  }

  protected glyph(node: FileNode): string {
    if (node.kind === 'dir') {
      return this.expanded().has(node.path) ? '▾' : '▸';
    }
    return fileGlyph(node.name);
  }

  protected isExpanded(path: string): boolean {
    return this.expanded().has(path);
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

  /**
   * Drag the pane's top edge. The height is measured from the pane's own fixed
   * bottom, so the list above gives way exactly as much as the pointer moves.
   */
  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const host = this.host.nativeElement;
    const bottom = host.getBoundingClientRect().bottom;
    const navTop = host.parentElement?.getBoundingClientRect().top ?? 0;
    const max = Math.max(MIN_EXPLORER_HEIGHT, bottom - navTop - 120);
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      this.shell.setExplorerHeight(Math.min(max, bottom - moveEvent.clientY));
    };
    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }
}

function flatten(nodes: readonly FileNode[], expanded: ReadonlySet<string>): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const walk = (list: readonly FileNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth });
      if (node.kind === 'dir' && expanded.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return rows;
}

function countFiles(nodes: readonly FileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += node.kind === 'file' ? 1 : countFiles(node.children);
  }
  return count;
}
