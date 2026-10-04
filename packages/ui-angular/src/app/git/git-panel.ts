import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { GitCommit } from '@morse/protocol';
import { MorseService } from '../core/morse.service';
import { ShellState } from '../core/shell-state';
import { GitPanelState } from '../core/git-panel-state';
import { layoutGraph, type GraphEdge, type GraphRow } from '../core/git-graph';
import { changeKind, type ChangeKind } from '../core/git-status';
import { WorkspaceFiles } from '../core/workspace-files';
import { WorkspaceTabs } from '../core/workspace-tabs';

/** One uncommitted file, ready for the Changes section. */
interface ChangeView {
  path: string;
  kind: ChangeKind;
}

/** Lane colours, drawn from the theme's chart palette so both themes read well. */
const PALETTE = [
  'var(--morse-accent)',
  'var(--morse-success)',
  'var(--morse-number)',
  'var(--morse-typename)',
  'var(--morse-keyword)',
  'var(--morse-info)',
  'var(--morse-warn)',
];

/** One lane is 16px wide; a row is one commit and the graph height around it. */
const LANE_WIDTH = 16;
const ROW_HEIGHT = 32;

/**
 * The browser host's git panel: the active project's recent commits and their
 * branch graph. VS Code has Source Control and leaves `capabilities.gitPanel`
 * off, so this never renders there; the browser host turns it on and answers the
 * `gitLog` command.
 *
 * The graph is a pure layout (`core/git-graph.ts`) turned into an SVG per row;
 * the panel itself only fetches, formats and scrolls.
 */
@Component({
  selector: 'morse-git-panel',
  templateUrl: './git-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /*
       * A block with the header pinned on top and the list filling the rest:
       * both children are absolutely positioned against this box, so the list's
       * height is the panel's own height and it scrolls on its own — no reliance
       * on a flex chain being height-constrained by the grid.
       */
      :host {
        position: relative;
        display: block;
        min-width: 0;
        min-height: 0;
        height: 100%;
        overflow: hidden;
        border-left: 1px solid var(--morse-border);
        background: var(--morse-nav-bg);
      }
      .head {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: var(--morse-head-height);
        padding: 0 6px 0 10px;
        border-bottom: 1px solid var(--morse-border);
        background: var(--morse-nav-bg);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        font-weight: 600;
      }
      .brand svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      /*
       * One compact chip for the header branch and the commit decorations: a
       * uniform subtle background, and the kind carried by the text colour only.
       * Filling each kind with its own colour made the HEAD chip look bulky and
       * inconsistent with the others.
       */
      .branch,
      .ref {
        flex: none;
        padding: 0 6px;
        border-radius: 4px;
        font-family: var(--morse-font-mono);
        font-size: 10px;
        line-height: 16px;
        background: color-mix(in srgb, var(--morse-fg-muted) 12%, transparent);
        color: var(--morse-fg-muted);
      }
      .branch,
      .ref.kind-head {
        color: var(--morse-accent);
      }
      .ref.kind-local {
        color: var(--morse-success);
      }
      .ref.kind-tag {
        color: var(--morse-typename);
      }
      .grow {
        flex: 1;
      }
      .icon {
        flex: none;
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      .icon:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .icon svg {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .count {
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      /* The area under the header is a column: changes on top, history below. */
      .body {
        position: absolute;
        top: var(--morse-head-height);
        right: 0;
        bottom: 0;
        left: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .changes {
        flex: none;
        height: 45%;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        overflow-x: hidden;
      }
      /* Folded: just its header. History folded: the changes take the column. */
      .body.changes-collapsed .changes,
      .body.history-collapsed .changes {
        height: auto;
      }
      .body.history-collapsed .changes {
        flex: 1;
      }
      .divider {
        flex: none;
        position: relative;
        height: 5px;
        border-top: 1px solid var(--morse-border);
        background: transparent;
        cursor: ns-resize;
      }
      .divider:hover {
        border-top-color: var(--morse-accent);
        background: color-mix(in srgb, var(--morse-accent) 30%, transparent);
      }
      /* A 5px line is a thin target; the overlay gives it a forgiving hit area. */
      .divider::after {
        content: '';
        position: absolute;
        inset: -3px 0;
      }
      .divider.gone {
        display: none;
      }
      .history {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .body.history-collapsed .history {
        flex: none;
      }
      .section-head {
        display: flex;
        flex: none;
        align-items: center;
      }
      .section-toggle {
        display: flex;
        align-items: center;
        gap: 5px;
        flex: 1;
        min-width: 0;
        padding: 5px 10px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .section-toggle:hover {
        background: var(--morse-hover);
      }
      .chevron {
        flex: none;
        display: inline-block;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1;
        transition: transform 120ms ease;
      }
      .chevron.open {
        transform: rotate(90deg);
      }
      .section-title {
        font-size: 10.5px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
      }
      .section-count {
        font-size: 10.5px;
        color: var(--morse-fg-muted);
      }
      .change-list {
        margin: 0;
        padding: 0 0 6px;
        list-style: none;
      }
      .change {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 2px 10px;
        border: 0;
        background: none;
        color: var(--morse-fg);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .change:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .change-dir {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .change-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      /*
       * An empty section is not a sentence in the corner: a centred, gently
       * animated mark says "nothing to do" before the text does.
       */
      .empty {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 16px;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
        text-align: center;
      }
      .mark {
        position: relative;
        display: inline-grid;
        place-items: center;
        width: 38px;
        height: 38px;
        animation: mark-breathe 2.8s ease-in-out infinite;
      }
      .mark svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mark .ring {
        stroke: color-mix(in srgb, var(--morse-fg-muted) 40%, transparent);
        stroke-width: 1.4;
      }
      .mark .check {
        stroke: var(--morse-success);
        stroke-width: 2;
        stroke-dasharray: 20;
        stroke-dashoffset: 20;
        animation: check-draw 900ms ease-out 120ms forwards;
      }
      .mark.node .line {
        stroke: color-mix(in srgb, var(--morse-fg-muted) 35%, transparent);
        stroke-width: 1.4;
      }
      .mark.node .dot {
        stroke: var(--morse-accent);
        stroke-width: 1.6;
        transform-box: fill-box;
        transform-origin: center;
        animation: node-pulse 2.8s ease-in-out infinite;
      }
      /* A soft ping leaving the mark, so "ready" reads as alive, not stuck. */
      .mark::after {
        content: '';
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--morse-success) 45%, transparent);
        animation: mark-ping 2.8s ease-out infinite;
      }
      .mark.node::after {
        border-color: color-mix(in srgb, var(--morse-accent) 45%, transparent);
      }
      @keyframes mark-breathe {
        0%,
        100% {
          transform: scale(0.95);
        }
        50% {
          transform: scale(1.05);
        }
      }
      @keyframes check-draw {
        to {
          stroke-dashoffset: 0;
        }
      }
      @keyframes node-pulse {
        0%,
        100% {
          transform: scale(0.7);
          opacity: 0.6;
        }
        50% {
          transform: scale(1.15);
          opacity: 1;
        }
      }
      @keyframes mark-ping {
        0% {
          transform: scale(0.85);
          opacity: 0.7;
        }
        70%,
        100% {
          transform: scale(1.35);
          opacity: 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .mark,
        .mark::after {
          animation: none;
        }
        .mark .check {
          animation: none;
          stroke-dashoffset: 0;
        }
        .mark.node .dot {
          animation: none;
        }
      }
      /* The git badge, shared with the Explorer: one letter, coloured by kind. */
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
      /* The graph list fills the rest and is the other scroll area. */
      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        margin: 0;
        padding: 2px 0 10px;
        list-style: none;
      }
      .hint {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 12px;
        color: var(--morse-fg-muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .hint.error {
        color: var(--morse-error);
      }
      /* The footer of the loaded range: a hint to scroll, or the root commit. */
      .more {
        padding: 10px 12px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        text-align: center;
      }
      /* One line per commit, so the list reads as a stream, not a stack of cards. */
      .commit {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 32px;
        padding-right: 8px;
      }
      .commit:hover {
        background: var(--morse-hover);
      }
      /*
       * One SVG per row, stacked with no gap: a lane reads as one continuous line
       * and the curves join across rows.
       */
      .graph {
        flex: none;
        display: block;
        overflow: visible;
      }
      .graph path {
        fill: none;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .graph circle {
        stroke: var(--morse-nav-bg);
        stroke-width: 1.6;
      }
      /*
       * A light dash travelling down each lane: the graph reads as flow, not a
       * static diagram. Same path as the lane, drawn over it with an animated
       * dash offset so the pulse keeps its direction across stacked rows.
       */
      .graph path.flow {
        stroke: var(--morse-fg);
        stroke-dasharray: 5 15;
        stroke-linecap: round;
        opacity: 0.35;
        animation: graph-flow 1.4s linear infinite;
      }
      @keyframes graph-flow {
        to {
          stroke-dashoffset: -20;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .graph path.flow {
          animation: none;
          opacity: 0;
        }
      }
      .subject {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
        color: var(--morse-fg);
      }
      .refs {
        flex: none;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }
      .grow {
        flex: 1;
        min-width: 8px;
      }
      .meta {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        white-space: nowrap;
      }
      .hash {
        font-family: var(--morse-font-mono);
      }
      /* The author is noise at sidebar width; the expanded view has room for it. */
      .author {
        display: none;
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .commit.expanded .author {
        display: inline;
      }
      .sep {
        opacity: 0.5;
      }
      .copy {
        flex: none;
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        cursor: pointer;
        opacity: 0;
      }
      .commit:hover .copy {
        opacity: 1;
      }
      .copy:hover:not(:disabled) {
        background: var(--morse-border);
        color: var(--morse-fg);
      }
    `,
  ],
})
export class GitPanel {
  /** Expanded: the panel spans the conversation area, for a wide graph. */
  readonly expanded = input(false);

  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly git = inject(GitPanelState);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly tabs = inject(WorkspaceTabs);

  protected readonly commits = this.git.commits;
  protected readonly branch = this.git.branch;
  protected readonly root = this.git.root;
  protected readonly isRepo = this.git.isRepo;
  protected readonly loading = this.git.loading;
  protected readonly loaded = this.git.loaded;
  protected readonly hasMore = this.git.hasMore;
  protected readonly error = this.git.error;
  protected readonly changesCollapsed = this.shell.gitChangesCollapsed;
  protected readonly historyCollapsed = this.shell.gitHistoryCollapsed;
  private readonly changesHeight = this.shell.gitChangesHeight;
  /** The uncommitted changes, from the shared working-tree poll. */
  protected readonly changes = computed<ChangeView[]>(() => {
    const status = this.workspace.status();
    if (status === undefined || !status.isRepo) {
      return [];
    }
    const changes: ChangeView[] = [];
    for (const file of status.files) {
      const kind = changeKind(file.status);
      if (kind !== undefined) {
        changes.push({ path: file.path, kind });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  });
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly copied = signal<string | undefined>(undefined);

  /** The graph layout and its commits, paired so the template walks one list. */
  protected readonly entries = computed(() => {
    const commits = this.commits();
    const layout = layoutGraph(commits);
    return {
      laneCount: layout.laneCount,
      rows: layout.rows.map((row, index) => {
        const commit = commits[index]!;
        // Two chips at most: a commit with five decorations would otherwise eat
        // the whole row in the sidebar. The rest collapse into a `+N`.
        return {
          row,
          commit,
          refs: commit.refs.slice(0, 2),
          moreRefs: Math.max(0, commit.refs.length - 2),
        };
      }),
    };
  });
  protected readonly graphWidth = computed(() =>
    Math.max(1, this.entries().laneCount) * LANE_WIDTH,
  );

  constructor() {
    // The panel follows the project: opening it, or switching to a session in
    // another directory, reloads the history. Closed, it costs nothing.
    effect(() => {
      if (!this.shell.gitPanelOpen()) {
        return;
      }
      const cwd = this.morse.workspace().cwd;
      if (!cwd) {
        return;
      }
      this.git.refresh();
    });
  }

  protected refresh(): void {
    this.git.refresh();
  }

  /**
   * Lazy paging: near the end of what is loaded, ask for the next page, so the
   * list walks all the way back to the root commit as the reader scrolls.
   */
  protected onScroll(event: Event): void {
    const list = event.target as HTMLElement;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 600) {
      this.git.loadMore();
    }
  }

  protected close(): void {
    this.shell.closeGitPanel();
  }

  /** Opens a changed file in a preview tab, the way the Explorer does. */
  protected openChange(path: string): void {
    this.tabs.openFile(path);
  }

  /** The directory part of a path, with its trailing slash, for the muted label. */
  protected dirOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash + 1);
  }

  protected baseOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
  }

  /** Wide mode: the graph leaves the sidebar and takes the centre of the shell. */
  protected toggleExpanded(): void {
    this.shell.toggleGitPanelExpanded();
  }

  protected toggleChanges(): void {
    this.shell.toggleGitChanges();
  }

  protected toggleHistory(): void {
    this.shell.toggleGitHistory();
  }

  /** The inline height only while both sections are open; otherwise CSS decides. */
  protected changesHeightPx(): number | null {
    if (this.changesCollapsed() || this.historyCollapsed()) {
      return null;
    }
    return this.changesHeight() ?? null;
  }

  /**
   * Drag the divider to size the Changes section. The height is measured from the
   * section column's own top, and the History keeps at least 80px so it cannot be
   * squeezed out of existence.
   */
  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const body = handle.parentElement;
    if (!body) {
      return;
    }
    const top = body.getBoundingClientRect().top;
    const bottom = body.getBoundingClientRect().bottom;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      this.shell.setGitChangesHeight(Math.min(bottom - top - 80, moveEvent.clientY - top));
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

  /** `HEAD -> main`, `tag: v1.0` and `origin/main` each read their own way. */
  protected refLabel(ref: string): string {
    if (ref.startsWith('tag: ')) {
      return ref.slice(5);
    }
    const arrow = ref.indexOf(' -> ');
    return arrow === -1 ? ref : ref.slice(arrow + 4);
  }

  protected refKind(ref: string): 'head' | 'tag' | 'local' {
    if (ref.startsWith('tag: ')) {
      return 'tag';
    }
    return ref.includes('HEAD') ? 'head' : 'local';
  }

  /** `12s` / `5m` / `3h` / `2d`, matching the sidebar's session ages. */
  protected when(iso: string): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) {
      return '';
    }
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    return `${Math.round(hours / 24)}d`;
  }

  protected async copy(commit: GitCommit): Promise<void> {
    try {
      await navigator.clipboard.writeText(commit.hash);
      this.copied.set(commit.hash);
      setTimeout(() => {
        if (this.copied() === commit.hash) {
          this.copied.set(undefined);
        }
      }, 1_200);
    } catch {
      // A host without clipboard access simply does not offer the affordance.
    }
  }

  protected x(lane: number): number {
    return lane * LANE_WIDTH + LANE_WIDTH / 2;
  }

  protected y(value: number): number {
    return value * ROW_HEIGHT;
  }

  protected color(index: number): string {
    return PALETTE[index % PALETTE.length]!;
  }

  /** An edge is a straight line within a lane, or a smooth S into/out of a node. */
  protected path(edge: GraphEdge): string {
    const x1 = this.x(edge.fromLane);
    const y1 = this.y(edge.fromY);
    const x2 = this.x(edge.toLane);
    const y2 = this.y(edge.toY);
    if (x1 === x2) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    // A lane change is a cubic whose control points sit halfway, so the line
    // leaves and arrives vertically — a flow, not a right-angled detour.
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }

  protected rowColor(row: GraphRow): string {
    return this.color(row.color);
  }
}
