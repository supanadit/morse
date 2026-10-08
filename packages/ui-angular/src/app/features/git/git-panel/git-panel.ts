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
import { MorseService } from '../../../host/morse.service';
import { ShellState } from '../../../state/shell-state';
import { LayoutState } from '../../../state/layout-state';
import { GitPanelState } from '../../../services/git-panel-state';
import {
  asCommitFiles,
  changeKind,
  isStaged,
  isUnstaged,
  layoutGraph,
  stagedKind,
  unstagedKind,
  type ChangeKind,
  type GraphEdge,
  type GraphRow,
} from '@morse/ui-runtime';
import { BranchPicker } from '../branch-picker/branch-picker';
import { WorkspaceFiles } from '../../../services/workspace-files.service';
import { WorkspaceFilesStore } from '../../../state/workspace-files.store';
import { WorkspaceTabs } from '../../../state/workspace-tabs';
import { startResize } from '../../../ui/resize-drag';

/** One uncommitted file, ready for the Changes section. */
interface ChangeView {
  path: string;
  kind: ChangeKind;
}

/** One file a commit touched, ready for the graph's expanded row. */
interface CommitFileView {
  path: string;
  kind: ChangeKind;
}

/** The lazily-loaded file list of one expanded commit. */
interface CommitFilesState {
  loading: boolean;
  files: CommitFileView[];
  error?: string;
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
/** Dragging the panel's left edge keeps at least this much conversation visible. */
const GIT_RESIZE_MIN_CHAT = 180;

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
  imports: [BranchPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './git-panel.css',
})
export class GitPanel {
  /** Expanded: the panel spans the conversation area, for a wide graph. */
  readonly expanded = input(false);

  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly layout = inject(LayoutState);
  private readonly git = inject(GitPanelState);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
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
  /** Each change group folds on its own, the way VS Code's Source Control does. */
  protected readonly stagedCollapsed = this.shell.gitStagedCollapsed;
  protected readonly unstagedCollapsed = this.shell.gitUnstagedCollapsed;
  private readonly changesHeight = this.shell.gitChangesHeight;
  /** True while a stage/unstage round trip is in flight, so the rows stay quiet. */
  protected readonly staging = signal(false);
  /**
   * The uncommitted changes, from the shared working-tree poll, split the way
   * `git status` does: the index (`X`) is Staged Changes, the working tree (`Y`)
   * is Changes. A path edited in both sides (`MM`) appears in both lists.
   */
  protected readonly staged = computed<ChangeView[]>(() => this.changesFor('staged'));
  protected readonly unstaged = computed<ChangeView[]>(() => this.changesFor('unstaged'));
  /** Distinct changed paths, so a file edited on both sides counts once. */
  protected readonly changedCount = computed(() => {
    const status = this.workspaceStore.status();
    return status?.isRepo ? status.files.length : 0;
  });
  /** A commit needs a message and something staged, and only one at a time. */
  protected readonly canCommit = computed(
    () => this.commitMessage().trim().length > 0 && this.staged().length > 0 && !this.committing(),
  );

  private changesFor(side: 'staged' | 'unstaged'): ChangeView[] {
    const status = this.workspaceStore.status();
    if (status === undefined || !status.isRepo) {
      return [];
    }
    const changes: ChangeView[] = [];
    for (const file of status.files) {
      const wanted = side === 'staged' ? isStaged(file.status) : isUnstaged(file.status);
      if (!wanted) {
        continue;
      }
      const kind = side === 'staged' ? stagedKind(file.status) : unstagedKind(file.status);
      if (kind !== undefined) {
        changes.push({ path: file.path, kind });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly copied = signal<string | undefined>(undefined);
  /** How far the branch is from its upstream, and its pull/push controls. */
  protected readonly ahead = this.git.ahead;
  protected readonly behind = this.git.behind;
  protected readonly upstream = this.git.upstream;
  protected readonly syncing = this.git.syncingNow;
  protected readonly syncLabel = computed(() => {
    const upstream = this.upstream();
    if (upstream === undefined) {
      return 'No upstream branch to pull from or push to';
    }
    return `${upstream}: ${this.behind()} to pull, ${this.ahead()} to push`;
  });
  /** The branches the picker lists, and the state of a commit/checkout. */
  protected readonly branches = this.git.branches;
  protected readonly switching = this.git.switching;
  protected readonly committing = this.git.committing;
  protected readonly notice = this.git.notice;
  /** Whether the branch picker is open; the panel owns that, not the picker. */
  protected readonly branchOpen = signal(false);
  /** The commit message being typed; Enter or the Commit button sends it. */
  protected readonly commitMessage = signal('');
  /** The commit whose file list is unfolded; `undefined` when all are folded. */
  protected readonly openCommit = signal<string | undefined>(undefined);
  /** The file list of each commit that was unfolded, kept so re-opening is free. */
  private readonly commitFiles = signal<Record<string, CommitFilesState>>({});

  /** The graph layout and its commits, paired so the template walks one list. */
  protected readonly entries = computed(() => {
    const commits = this.commits();
    const layout = layoutGraph(commits);
    // A commit two branches point at must not stack two long chips in a sidebar
    // row: show the first (the HEAD or branch ref) and fold the rest into `+N`,
    // whose title names them. The expanded view has room for more.
    const maxRefs = this.expanded() ? 3 : 1;
    return {
      laneCount: layout.laneCount,
      rows: layout.rows.map((row, index) => {
        const commit = commits[index]!;
        const refs = commit.refs.slice(0, maxRefs);
        const rest = commit.refs.slice(maxRefs);
        return {
          row,
          commit,
          refs,
          moreRefs: rest.length,
          restTitle: rest.map((ref) => this.refLabel(ref)).join(', '),
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
      if (!this.layout.rightVisible()) {
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

  /** Pulls the upstream; the graph and the distance are re-read afterwards. */
  protected pull(): void {
    void this.git.pull();
  }

  /** Pushes the branch; the graph and the distance are re-read afterwards. */
  protected push(): void {
    void this.git.push();
  }

  /** Opens the branch switcher, reading the branch list on the way in. */
  protected toggleBranchPicker(): void {
    if (this.branchOpen()) {
      this.branchOpen.set(false);
      return;
    }
    this.git.loadBranches();
    this.branchOpen.set(true);
  }

  protected closeBranchPicker(): void {
    this.branchOpen.set(false);
  }

  /** Switches to an existing branch (a remote name checks out its local twin). */
  protected pickBranch(branch: string): void {
    this.branchOpen.set(false);
    void this.git.checkout(branch, false);
  }

  /** Creates a branch and switches to it in one step. */
  protected createBranch(branch: string): void {
    this.branchOpen.set(false);
    void this.git.checkout(branch, true);
  }

  /** Checks out a tag or commit directly; git leaves HEAD detached. */
  protected detachRef(ref: string): void {
    this.branchOpen.set(false);
    void this.git.checkout(ref, false);
  }

  protected onCommitMessage(event: Event): void {
    this.commitMessage.set((event.target as HTMLInputElement).value);
  }

  /** Commits what is staged; the message clears only when git accepted it. */
  protected submitCommit(): void {
    const message = this.commitMessage().trim();
    if (message.length === 0 || this.committing()) {
      return;
    }
    // Enter in the message box goes through here too, so the button's own guard
    // is repeated: nothing staged is not a commit, and saying so beats asking git
    // and showing its raw refusal.
    if (this.staged().length === 0) {
      this.git.refuse('Nothing is staged to commit. Stage a change first.');
      return;
    }
    void this.git.commit(message).then((ok) => {
      if (ok) {
        this.commitMessage.set('');
      }
    });
  }

  /** Whether a commit's file list is unfolded. */
  protected isCommitOpen(hash: string): boolean {
    return this.openCommit() === hash;
  }

  /** A commit's file list, empty until it is unfolded and loaded. */
  protected commitState(hash: string): CommitFilesState {
    return this.commitFiles()[hash] ?? { loading: false, files: [] };
  }

  /**
   * Unfolds a commit row to its changed files, folding the previous one. The
   * list is read once (`gitCommitFiles`) and kept, so re-opening is free.
   */
  protected toggleCommit(hash: string): void {
    if (this.openCommit() === hash) {
      this.openCommit.set(undefined);
      return;
    }
    this.openCommit.set(hash);
    const existing = this.commitFiles()[hash];
    if (existing !== undefined && existing.error === undefined) {
      return;
    }
    this.commitFiles.update((map) => ({
      ...map,
      [hash]: { loading: true, files: [] },
    }));
    void this.morse.requestHostCommand('gitCommitFiles', { hash }).then((data) => {
      const files = asCommitFiles(data);
      if (files === undefined) {
        this.commitFiles.update((map) => ({
          ...map,
          [hash]: { loading: false, files: [], error: 'Could not read this commit.' },
        }));
        return;
      }
      const views: CommitFileView[] = [];
      for (const file of files) {
        const kind = changeKind(file.status);
        if (kind !== undefined) {
          views.push({ path: file.path, kind });
        }
      }
      views.sort((a, b) => a.path.localeCompare(b.path));
      this.commitFiles.update((map) => ({
        ...map,
        [hash]: { loading: false, files: views },
      }));
    });
  }

  /** Opens one file's diff inside that commit, in its own preview tab. */
  protected openCommitChange(hash: string, path: string, subject: string): void {
    this.tabs.openCommitFile(hash, path, subject);
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
    this.layout.setVisible('right', false);
  }

  /** Opens a changed file in a preview tab, the way the Explorer does. */
  protected openChange(path: string): void {
    this.tabs.openFile(path);
  }

  /** Moves one path into the index (`git add`). */
  protected stage(path: string): void {
    void this.runStage([path]);
  }

  /** Takes one path back out of the index, keeping the working-tree change. */
  protected unstage(path: string): void {
    void this.runUnstage([path]);
  }

  /** Every unstaged path into the index at once. */
  protected stageAll(): void {
    void this.runStage(this.unstaged().map((change) => change.path));
  }

  /** Every staged path back out of the index at once. */
  protected unstageAll(): void {
    void this.runUnstage(this.staged().map((change) => change.path));
  }

  private async runStage(paths: string[]): Promise<void> {
    if (paths.length === 0 || this.staging()) {
      return;
    }
    this.staging.set(true);
    try {
      await this.workspace.stage(paths);
    } finally {
      this.staging.set(false);
    }
  }

  private async runUnstage(paths: string[]): Promise<void> {
    if (paths.length === 0 || this.staging()) {
      return;
    }
    this.staging.set(true);
    try {
      await this.workspace.unstage(paths);
    } finally {
      this.staging.set(false);
    }
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

  /** Folds the Staged group's rows under its header, leaving the header in place. */
  protected toggleStaged(): void {
    this.shell.toggleGitStaged();
  }

  /** Folds the Unstaged group's rows under its header, leaving the header in place. */
  protected toggleUnstaged(): void {
    this.shell.toggleGitUnstaged();
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
    const handle = event.currentTarget as HTMLElement;
    const body = handle.parentElement;
    if (!body) {
      return;
    }
    /*
     * The height belongs to the Changes section, which is the divider's own
     * previous sibling — not to the body. The body also holds the sync bar and
     * the commit box above Changes, so measuring from the body's top made the
     * divider jump down by exactly that offset the moment the drag started.
     * The grab point is folded in too (start height + pointer delta), so the
     * divider stays under the cursor wherever the handle was grabbed.
     */
    const changes = (handle.previousElementSibling as HTMLElement | null) ?? body;
    const top = changes.getBoundingClientRect().top;
    const bottom = body.getBoundingClientRect().bottom;
    const startY = event.clientY;
    const startHeight = changes.getBoundingClientRect().height;
    startResize(event, {
      // 80px of History stays visible, so the section cannot be squeezed out.
      value: (pointer) => Math.min(bottom - top - 80, startHeight + (pointer.clientY - startY)),
      preview: (height) => this.shell.setGitChangesHeight(height, false),
      commit: (height) => this.shell.setGitChangesHeight(height),
    });
  }

  /**
   * Drag the panel's left edge to size it against the conversation. The grid
   * column is what changes, so pulling left (a negative delta) widens the panel,
   * and the drag leaves full mode first or the column would not follow. At least
   * 180px of conversation stays visible, so the chat never vanishes by accident —
   * the expand button is still the way to hand the graph everything.
   */
  protected startWidthResize(event: PointerEvent): void {
    if (this.shell.gitPanelExpanded()) {
      this.shell.toggleGitPanelExpanded();
    }
    const handle = event.currentTarget as HTMLElement;
    const panel = handle.parentElement;
    const startX = event.clientX;
    const startWidth = panel?.getBoundingClientRect().width ?? 340;
    const shell = handle.closest('.shell') as HTMLElement | null;
    const nav = shell?.querySelector('.nav') as HTMLElement | null;
    const shellWidth = shell?.getBoundingClientRect().width ?? window.innerWidth;
    const navWidth = this.layout.leftCollapsed()
      ? 0
      : (nav?.getBoundingClientRect().width ?? 240);
    const max = Math.max(320, shellWidth - navWidth - GIT_RESIZE_MIN_CHAT);
    startResize(event, {
      /*
       * Resizing has to follow the pointer, not the shell's 160ms column transition:
       * retargeting that animation on every move made the drag feel heavy. The graph's flow
       * is paused for the other half of the cost — repainting hundreds of animated dashes
       * while the column moves.
       */
      begin: () => {
        shell?.style.setProperty('transition', 'none');
        panel?.classList.add('resizing');
      },
      end: () => {
        shell?.style.removeProperty('transition');
        panel?.classList.remove('resizing');
      },
      // Pulling left (a negative delta) widens the panel, so the column is what changes.
      value: (pointer) => Math.min(max, startWidth + (startX - pointer.clientX)),
      preview: (width) => this.layout.setSize('right', width, false),
      commit: (width) => this.layout.setSize('right', width),
    });
  }

  /** Double-clicking the edge restores the default column width. */
  protected resetWidth(): void {
    this.layout.setSize('right', undefined);
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

  /**
   * The hover tooltip for a commit row: the full subject the sidebar trims with
   * an ellipsis, every ref including the ones folded into `+N`, and the identity
   * (author, exact time, hash) git shows. A native `title`, so the browser owns
   * the placement and the panel needs no overlay of its own.
   */
  protected commitTitle(commit: GitCommit): string {
    const lines = [commit.subject];
    if (commit.refs.length > 0) {
      lines.push('', ...commit.refs.map((ref) => this.refDetail(ref)));
    }
    lines.push('', `${commit.author} · ${this.exactTime(commit.date)}`, commit.hash);
    return lines.join('\n');
  }

  /** `HEAD -> main`, `tag: v1.0`, `origin/main` spelled out for the tooltip. */
  private refDetail(ref: string): string {
    if (ref.startsWith('tag: ')) {
      return `tag ${ref.slice(5)}`;
    }
    const arrow = ref.indexOf(' -> ');
    return arrow === -1 ? ref : `HEAD → ${ref.slice(arrow + 4)}`;
  }

  /** The exact commit time, in the viewer's locale — `when` only says "9h". */
  private exactTime(iso: string): string {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
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

  /**
   * The lanes that continue *below* a commit's row: every edge that leaves its
   * row at the bottom. An expanded file list pushes the next row down, so the
   * graph must draw these lanes across the extra height or the line looks cut.
   */
  protected continuing(row: GraphRow): GraphEdge[] {
    return row.edges.filter((edge) => edge.toY === 1);
  }

  protected rowColor(row: GraphRow): string {
    return this.color(row.color);
  }
}
