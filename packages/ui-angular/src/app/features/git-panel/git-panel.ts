import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { GitCommit } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { LayoutState } from '../../state/layout-state';
import { GitPanelState, GitRepoState } from '../../services/git-panel-state';
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
  type TreeNode,
} from '@morse/ui-runtime';
import { BranchPicker } from '../branch-picker/branch-picker';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { Pane } from '../../ui/pane/pane';
import { Splitter } from '../../ui/splitter/splitter';
import { TreeList } from '../../ui/tree-list/tree-list';
import type { PaneAction } from '../../ui/pane/pane';

/** One uncommitted file, ready for the Changes section. */
interface ChangeView {
  path: string;
  kind: ChangeKind;
}

/** The two root ids of the changes tree, so a fold can address one group. */
const STAGED_GROUP = 'staged';
const UNSTAGED_GROUP = 'unstaged';

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

/** A commit row paired with its graph geometry and trimmed refs. */
interface CommitEntry {
  row: GraphRow;
  commit: GitCommit;
  refs: string[];
  moreRefs: number;
  restTitle: string;
}

/** Everything one repository's section draws, derived once per change. */
interface RepoView {
  state: GitRepoState;
  path: string;
  staged: ChangeView[];
  unstaged: ChangeView[];
  changedCount: number;
  changeNodes: TreeNode<ChangeView>[];
  changesExpanded: ReadonlySet<string>;
  entries: { laneCount: number; rows: CommitEntry[] };
  graphWidth: number;
  canCommit: boolean;
}

/**
 * The browser host's git panel: the repositories under the active project, each
 * with its recent commits and branch graph, plus its working tree. VS Code has
 * Source Control and leaves `capabilities.gitPanel` off, so this never renders
 * there; the browser host turns it on and answers the git commands.
 *
 * A project can hold several repositories — its own plus nested ones (a
 * submodule, a separate checkout) — so they are drawn as an accordion, one
 * section per repository, each folding on its own. Stage, commit, checkout, pull
 * and push all act on the repository whose section was clicked, which is why
 * every command carries a `repo` argument.
 *
 * The graph is a pure layout (`core/git-graph.ts`) turned into an SVG per row;
 * the panel itself only fetches, formats and scrolls.
 */
@Component({
  selector: 'morse-git-panel',
  templateUrl: './git-panel.html',
  imports: [NgTemplateOutlet, Pane, BranchPicker, Splitter, TreeList],
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
  private readonly tabs = inject(WorkspaceTabs);

  protected readonly repos = this.git.repos;
  protected readonly isRepo = this.git.isRepo;
  protected readonly loading = this.git.loading;
  protected readonly loaded = this.git.loaded;
  protected readonly error = this.git.error;
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly copied = signal<string | undefined>(undefined);
  /** Which repository's branch picker is open, by repository path. */
  protected readonly branchOpen = signal<string | undefined>(undefined);
  /** The commit whose file list is unfolded, keyed by `<repo>:<hash>`. */
  protected readonly openCommit = signal<string | undefined>(undefined);
  /** The file list of each commit that was unfolded, kept so re-opening is free. */
  private readonly commitFiles = signal<Record<string, CommitFilesState>>({});
  /** The commit message being typed, per repository path. */
  private readonly messages = signal<Record<string, string>>({});
  /** True while a stage/unstage round trip is in flight. */
  protected readonly staging = signal(false);

  /**
   * Each repository's section, with its change groups and graph already derived,
   * so the template walks one list. The fold of every group comes from the
   * repository's own state (remembered per root), so two sections fold apart.
   */
  protected readonly views = computed<RepoView[]>(() =>
    this.repos().map((state) => this.viewOf(state)),
  );

  /** The path of the one open repository, or `undefined` when all are folded. */
  protected readonly openPath = this.git.openPath;
  /** The open repository's Changes fold, from the shell (one panel, one fold). */
  protected readonly changesCollapsed = this.shell.gitChangesCollapsed;
  /** The open repository's History fold, from the shell. */
  protected readonly historyCollapsed = this.shell.gitHistoryCollapsed;
  /** The dragged Changes height, or `null` while both sections share the room. */
  private readonly changesHeight = this.layout.changesSize;

  private viewOf(state: GitRepoState): RepoView {
    const commits = state.commits();
    const layout = layoutGraph(commits);
    // A commit two branches point at must not stack two long chips in a sidebar
    // row: show the first (the HEAD or branch ref) and fold the rest into `+N`.
    const maxRefs = this.expanded() ? 3 : 1;
    const rows = layout.rows.map((row, index) => {
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
    });
    return {
      state,
      path: state.info.path,
      staged: this.changesFor(state, 'staged'),
      unstaged: this.changesFor(state, 'unstaged'),
      changedCount: state.status()?.isRepo ? (state.status()?.files.length ?? 0) : 0,
      changeNodes: this.changeNodesFor(state),
      changesExpanded: this.changesExpandedFor(state),
      entries: { laneCount: layout.laneCount, rows },
      graphWidth: Math.max(1, layout.laneCount) * LANE_WIDTH,
      canCommit:
        this.messageFor(state).trim().length > 0 &&
        this.changesFor(state, 'staged').length > 0 &&
        !state.committing(),
    };
  }

  private changesFor(state: GitRepoState, side: 'staged' | 'unstaged'): ChangeView[] {
    const status = state.status();
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

  /**
   * The changes as the shared tree draws them: "Staged" and "Unstaged" are the
   * roots, each file a leaf one level down. The group's badge is its count, the
   * file's is its git letter; the group's `action` is the stage/unstage-all.
   */
  private changeNodesFor(state: GitRepoState): TreeNode<ChangeView>[] {
    const staged = this.changesFor(state, 'staged');
    const unstaged = this.changesFor(state, 'unstaged');
    const nodes: TreeNode<ChangeView>[] = [
      this.changeGroup(state, STAGED_GROUP, 'Staged', staged, 'unstaged'),
    ];
    if (unstaged.length > 0) {
      nodes.push(this.changeGroup(state, UNSTAGED_GROUP, 'Unstaged', unstaged, 'staged'));
    }
    return nodes;
  }

  private changeGroup(
    state: GitRepoState,
    id: string,
    label: string,
    changes: readonly ChangeView[],
    moveTo: 'staged' | 'unstaged',
  ): TreeNode<ChangeView> {
    return {
      id,
      label,
      data: changes[0] ?? { path: '', kind: 'M' },
      badge: changes.length.toString(),
      badgeTone: 'plain',
      kind: 'group',
      action:
        changes.length === 0
          ? undefined
          : {
              glyph: id === STAGED_GROUP ? '−' : '+',
              label: id === STAGED_GROUP ? 'Unstage all changes' : 'Stage all changes',
              run: () =>
                id === STAGED_GROUP ? this.unstageAll(state) : this.stageAll(state),
            },
      children: changes.map((change) => this.changeLeaf(state, change, moveTo)),
    };
  }

  private changeLeaf(
    state: GitRepoState,
    change: ChangeView,
    moveTo: 'staged' | 'unstaged',
  ): TreeNode<ChangeView> {
    const slash = change.path.lastIndexOf('/');
    return {
      id: change.path,
      label: slash === -1 ? change.path : change.path.slice(slash + 1),
      detail: slash === -1 ? undefined : change.path.slice(0, slash),
      data: change,
      badge: change.kind,
      badgeTone: this.toneOf(change.kind),
      kind: 'leaf',
      action: {
        glyph: moveTo === 'staged' ? '+' : '−',
        label: (moveTo === 'staged' ? 'Stage ' : 'Unstage ') + change.path,
        run: () => (moveTo === 'staged' ? this.stage(state, change.path) : this.unstage(state, change.path)),
      },
      children: [],
    };
  }

  /** The groups that are open, from the repository's own fold flags. */
  private changesExpandedFor(state: GitRepoState): ReadonlySet<string> {
    const set = new Set<string>();
    if (!state.stagedCollapsed()) {
      set.add(STAGED_GROUP);
    }
    if (!state.unstagedCollapsed()) {
      set.add(UNSTAGED_GROUP);
    }
    return set;
  }

  /** A git letter's tone, shared by the change rows and the commit-file rows. */
  private toneOf(kind: ChangeKind): TreeNode<ChangeView>['badgeTone'] {
    switch (kind) {
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

  /** A commit's files are all leaves: nothing to fold, so no id is ever open. */
  protected readonly noGroups: ReadonlySet<string> = new Set();

  /** The file rows of a commit, shaped the way the shared tree draws them. */
  protected commitFileNodes(repo: GitRepoState, hash: string): TreeNode<CommitFileView>[] {
    return this.commitState(repo, hash).files.map((file) => {
      const slash = file.path.lastIndexOf('/');
      return {
        id: file.path,
        label: slash === -1 ? file.path : file.path.slice(slash + 1),
        detail: slash === -1 ? undefined : file.path.slice(0, slash),
        data: file,
        badge: file.kind,
        badgeTone: this.toneOf(file.kind),
        kind: 'leaf' as const,
        children: [],
      };
    });
  }

  constructor() {
    // The panel follows the project: opening it, or switching to a session in
    // another directory, reloads the repository list and every history. Closed,
    // it costs nothing.
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

  /** Pulls the repository's upstream; the graph and the distance are re-read. */
  protected pull(state: GitRepoState): void {
    void state.pull();
  }

  /** Pushes the repository's branch; the graph and the distance are re-read. */
  protected push(state: GitRepoState): void {
    void state.push();
  }

  /** Opens one repository, folding whichever was open; clicking it again folds it. */
  protected toggleSection(path: string): void {
    this.git.toggleSection(path);
  }

  /** Opens the branch switcher for a section, reading its branch list on the way in. */
  protected toggleBranchPicker(state: GitRepoState): void {
    if (this.branchOpen() === state.info.path) {
      this.branchOpen.set(undefined);
      return;
    }
    state.loadBranches();
    this.branchOpen.set(state.info.path);
  }

  protected closeBranchPicker(): void {
    this.branchOpen.set(undefined);
  }

  /** Switches to an existing branch (a remote name checks out its local twin). */
  protected pickBranch(state: GitRepoState, branch: string): void {
    this.branchOpen.set(undefined);
    void state.checkout(branch, false);
  }

  /** Creates a branch and switches to it in one step. */
  protected createBranch(state: GitRepoState, branch: string): void {
    this.branchOpen.set(undefined);
    void state.checkout(branch, true);
  }

  /** Checks out a tag or commit directly; git leaves HEAD detached. */
  protected detachRef(state: GitRepoState, ref: string): void {
    this.branchOpen.set(undefined);
    void state.checkout(ref, false);
  }

  /** The message typed into one repository's commit box. */
  protected messageFor(state: GitRepoState): string {
    return this.messages()[state.info.path] ?? '';
  }

  protected onCommitMessage(state: GitRepoState, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.messages.update((map) => ({ ...map, [state.info.path]: value }));
  }

  /** Commits what is staged in the repository; the message clears only on success. */
  protected submitCommit(state: GitRepoState): void {
    const message = this.messageFor(state).trim();
    if (message.length === 0 || state.committing()) {
      return;
    }
    if (this.changesFor(state, 'staged').length === 0) {
      state.refuse('Nothing is staged to commit. Stage a change first.');
      return;
    }
    void state.commit(message).then((ok) => {
      if (ok) {
        this.messages.update((map) => ({ ...map, [state.info.path]: '' }));
      }
    });
  }

  protected syncLabel(state: GitRepoState): string {
    const upstream = state.upstream();
    if (upstream === undefined) {
      return 'No upstream branch to pull from or push to';
    }
    return `${upstream}: ${state.behind()} to pull, ${state.ahead()} to push`;
  }

  /** Whether a commit's file list is unfolded, keyed by repository and hash. */
  protected isCommitOpen(state: GitRepoState, hash: string): boolean {
    return this.openCommit() === this.commitKey(state, hash);
  }

  private commitKey(state: GitRepoState, hash: string): string {
    return `${state.info.path}\u0000${hash}`;
  }

  /** A commit's file list, empty until it is unfolded and loaded. */
  protected commitState(state: GitRepoState, hash: string): CommitFilesState {
    return this.commitFiles()[this.commitKey(state, hash)] ?? { loading: false, files: [] };
  }

  /**
   * Unfolds a commit row to its changed files, folding the previous one. The
   * list is read once (`gitCommitFiles`) and kept, so re-opening is free.
   */
  protected toggleCommit(state: GitRepoState, hash: string): void {
    const key = this.commitKey(state, hash);
    if (this.openCommit() === key) {
      this.openCommit.set(undefined);
      return;
    }
    this.openCommit.set(key);
    const existing = this.commitFiles()[key];
    if (existing !== undefined && existing.error === undefined) {
      return;
    }
    this.commitFiles.update((map) => ({ ...map, [key]: { loading: true, files: [] } }));
    const repo = state.info.path;
    void this.morse
      .requestHostCommand('gitCommitFiles', {
        hash,
        ...(repo.length > 0 ? { repo } : {}),
      })
      .then((data) => {
        const files = asCommitFiles(data);
        if (files === undefined) {
          this.commitFiles.update((map) => ({
            ...map,
            [key]: { loading: false, files: [], error: 'Could not read this commit.' },
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
        this.commitFiles.update((map) => ({ ...map, [key]: { loading: false, files: views } }));
      });
  }

  /** Opens one file's diff inside that commit, in its own preview tab. */
  protected openCommitChange(
    state: GitRepoState,
    hash: string,
    path: string,
    subject: string,
  ): void {
    this.tabs.openCommitFile(hash, path, subject, state.info.path || undefined);
  }

  /**
   * Lazy paging: near the end of what is loaded, ask for the next page, so the
   * list walks all the way back to the root commit as the reader scrolls.
   */
  protected onScroll(state: GitRepoState, event: Event): void {
    const list = event.target as HTMLElement;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 600) {
      state.loadMore();
    }
  }

  protected close(): void {
    this.layout.setVisible('right', false);
  }

  /** The shared tree reports the node it was given; a group folds, a file opens. */
  protected onChangeRow(state: GitRepoState, node: TreeNode<ChangeView>): void {
    if (node.kind === 'group') {
      this.toggleChangeGroup(state, node.id);
      return;
    }
    this.tabs.openFile(node.data.path, undefined, state.info.path || undefined);
  }

  /** A group's caret folds it, mirroring the repository's own fold flag. */
  protected onToggleChangeGroup(state: GitRepoState, node: TreeNode<ChangeView>): void {
    this.toggleChangeGroup(state, node.id);
  }

  private toggleChangeGroup(state: GitRepoState, id: string): void {
    if (id === STAGED_GROUP) {
      state.toggleStaged();
    } else {
      state.toggleUnstaged();
    }
  }

  /** A commit file row opens that file's diff inside the commit. */
  protected onCommitFileRow(
    state: GitRepoState,
    node: TreeNode<CommitFileView>,
    hash: string,
    subject: string,
  ): void {
    this.openCommitChange(state, hash, node.data.path, subject);
  }

  /** Moves one path into the repository's index (`git add`). */
  protected stage(state: GitRepoState, path: string): void {
    void this.runStage(state, [path]);
  }

  /** Takes one path back out of the index, keeping the working-tree change. */
  protected unstage(state: GitRepoState, path: string): void {
    void this.runUnstage(state, [path]);
  }

  /** Every unstaged path into the index at once. */
  protected stageAll(state: GitRepoState): void {
    void this.runStage(state, this.changesFor(state, 'unstaged').map((change) => change.path));
  }

  /** Every staged path back out of the index at once. */
  protected unstageAll(state: GitRepoState): void {
    void this.runUnstage(state, this.changesFor(state, 'staged').map((change) => change.path));
  }

  private async runStage(state: GitRepoState, paths: string[]): Promise<void> {
    if (paths.length === 0 || this.staging()) {
      return;
    }
    this.staging.set(true);
    try {
      await state.stage(paths);
    } finally {
      this.staging.set(false);
    }
  }

  private async runUnstage(state: GitRepoState, paths: string[]): Promise<void> {
    if (paths.length === 0 || this.staging()) {
      return;
    }
    this.staging.set(true);
    try {
      await state.unstage(paths);
    } finally {
      this.staging.set(false);
    }
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

  /** At least 80px of History stays visible, so the section cannot be squeezed out. */
  protected readonly changesMax = (handle: HTMLElement): number => {
    const body = handle.parentElement;
    const changes = (handle.previousElementSibling as HTMLElement | null) ?? body;
    if (body === null || changes === null) {
      return Number.POSITIVE_INFINITY;
    }
    const top = changes.getBoundingClientRect().top;
    const bottom = body.getBoundingClientRect().bottom;
    return Math.max(48, bottom - top - 80);
  };

  /** The title bar's buttons, as data: the pane draws them, so they look like every other panel's. */
  protected readonly paneActions = computed<readonly PaneAction[]>(() => [
    {
      id: 'expand',
      active: this.expanded(),
      label: this.expanded()
        ? 'Fit the git panel back into the sidebar'
        : 'Expand the git graph',
      run: () => this.toggleExpanded(),
    },
    { id: 'refresh', label: 'Refresh history', run: () => this.refresh(), disabled: this.loading() },
    { id: 'close', label: 'Hide the git panel', run: () => this.close() },
  ]);

  /**
   * At least 180px of conversation stays visible, so the chat never vanishes by accident —
   * the expand button is still the way to hand the graph everything.
   */
  protected readonly gitColumnMax = (handle: HTMLElement): number => {
    const shell = handle.closest('.shell') as HTMLElement | null;
    const nav = shell?.querySelector('.nav') as HTMLElement | null;
    const shellWidth = shell?.getBoundingClientRect().width ?? window.innerWidth;
    const navWidth = this.layout.leftCollapsed()
      ? 0
      : (nav?.getBoundingClientRect().width ?? 240);
    return Math.max(320, shellWidth - navWidth - GIT_RESIZE_MIN_CHAT);
  };

  /**
   * The column only follows once the panel is back in the sidebar, so a drag on its edge
   * leaves full mode first.
   */
  protected readonly leaveFullMode = (): void => {
    if (this.shell.gitPanelExpanded()) {
      this.shell.toggleGitPanelExpanded();
    }
  };

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

  /** The repository's display name: its folder, or the project for the session's own. */
  protected repoLabel(view: RepoView): string {
    return view.state.info.current ? view.state.info.name || 'This project' : view.state.info.name;
  }

  /**
   * The relative path a nested repository sits at, for its section's subtitle —
   * but only when it adds something to the name. A repository directly under the
   * session directory has `path === name` (both `container-docs`), so showing
   * both would print the same word twice.
   */
  protected repoDetail(view: RepoView): string | undefined {
    const path = view.state.info.path;
    return path.length === 0 || path === view.state.info.name ? undefined : path;
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
