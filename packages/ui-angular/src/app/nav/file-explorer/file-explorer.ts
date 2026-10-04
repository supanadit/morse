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
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';
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
 * The tree is built from the same flat, `git`-aware listing the composer's
 * `@mention` picker uses, so both surfaces offer the same files for the same
 * project and nothing is indexed twice.
 */
@Component({
  selector: 'morse-file-explorer',
  templateUrl: './file-explorer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // A dragged height replaces the default `max-height`; no height means the
    // CSS default stands.
    '[class.sized]': 'height() !== undefined',
    '[style.height.px]': 'height()',
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
      .root {
        flex: none;
        padding: 0 10px 4px 12px;
        font-size: 11px;
        font-weight: 600;
        color: var(--morse-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The persisted pane height, `undefined` while the CSS default applies. */
  protected readonly height = this.shell.explorerHeight;

  private readonly entries = signal<readonly string[]>([]);
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  private readonly loading = signal(false);
  private readonly error = signal<string | undefined>(undefined);
  private readonly folded = signal(false);
  /** The project the last request was for, so a streamed token does not re-list. */
  private requestedCwd = '';
  /** The project the expanded set belongs to, so switching projects folds it. */
  private expandedFor = '';

  protected readonly root = computed(() => {
    const workspace = this.morse.state().workspace;
    return {
      cwd: workspace.cwd,
      name: workspace.name || basename(workspace.cwd),
    };
  });
  private readonly tree = computed(() => buildFileTree(this.entries()));
  protected readonly rows = computed(() => flatten(this.tree(), this.expanded()));
  protected readonly fileCount = computed(() => countFiles(this.tree()));
  protected readonly collapsed = this.folded.asReadonly();
  protected readonly isLoading = this.loading.asReadonly();
  protected readonly errorMessage = this.error.asReadonly();

  constructor() {
    effect(() => {
      const cwd = this.morse.state().workspace.cwd;
      untracked(() => {
        // `state()` re-emits on every transcript update; only a new project deserves
        // another walk. A manual refresh calls `load` directly and skips this guard.
        if (cwd.length > 0 && cwd !== this.requestedCwd) {
          void this.load(cwd);
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

  protected toggleFold(): void {
    this.folded.update((value) => !value);
  }

  protected refresh(): void {
    void this.load(this.root().cwd);
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

  private async load(cwd: string): Promise<void> {
    this.requestedCwd = cwd;
    this.loading.set(true);
    this.error.set(undefined);
    try {
      const data = await this.morse.requestHostCommand('listFiles');
      if (this.root().cwd !== cwd) {
        return;
      }
      const files = asFileList(data);
      if (files === undefined) {
        this.entries.set([]);
        this.error.set('Could not list this project.');
        return;
      }
      if (this.expandedFor !== cwd) {
        this.expanded.set(new Set());
        this.expandedFor = cwd;
      }
      this.entries.set(files);
    } finally {
      if (this.root().cwd === cwd) {
        this.loading.set(false);
      }
    }
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

function asFileList(value: unknown): string[] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return undefined;
  }
  return files.filter((entry): entry is string => typeof entry === 'string');
}

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}
