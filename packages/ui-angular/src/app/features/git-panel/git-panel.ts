import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { LayoutState } from '../../state/layout-state';
import { GitPanelState, GitRepoState } from '../../services/git-panel-state';
import {
  fileIcon,
  isStaged,
  isUnstaged,
  stagedKind,
  unstagedKind,
  type ChangeKind,
  type TreeNode,
} from '@morse/ui-runtime';
import { BranchPicker } from '../branch-picker/branch-picker';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { Pane } from '../../ui/pane/pane';
import { Splitter } from '../../ui/splitter/splitter';
import { ChangeList, type ChangeGroupView, type ChangeView } from './change-list';
import type { PaneAction } from '../../ui/pane/pane';

/** Dragging the panel's left edge keeps at least this much conversation visible. */
const GIT_RESIZE_MIN_CHAT = 180;

/** Everything one repository's section draws, derived once per change. */
interface RepoView {
  state: GitRepoState;
  path: string;
  changedCount: number;
  changeGroups: ChangeGroupView[];
  matchingCount: number;
  stagedLabel: string | undefined;
  canCommit: boolean;
}

/**
 * The browser host's git column: the repositories under the active project and
 * their working trees — branch, sync, commit form and the staged/unstaged files.
 * History lives in the bottom panel's Git Log, which shares the same data.
 *
 * A project can hold several repositories — its own plus nested ones (a
 * submodule, a separate checkout) — so they are drawn as an accordion, one
 * section per repository, each folding on its own. Stage, commit, checkout, pull
 * and push all act on the repository whose section was clicked, which is why
 * every command carries a `repo` argument.
 */
@Component({
  selector: 'morse-git-panel',
  templateUrl: './git-panel.html',
  imports: [NgTemplateOutlet, Pane, BranchPicker, Splitter, ChangeList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './git-panel.css',
})
export class GitPanel {
  /** Expanded: the column spans the conversation area, for the wide form. */
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
  /** Which repository's branch picker is open, by repository path. */
  protected readonly branchOpen = signal<string | undefined>(undefined);
  /** The commit message being typed, per repository path. */
  private readonly messages = signal<Record<string, string>>({});
  /** True while a stage/unstage round trip is in flight. */
  protected readonly staging = signal(false);
  /** The changes filter, shared by every open repository. */
  protected readonly changeFilter = signal('');

  /**
   * Each repository's section, with its change groups already derived, so the
   * template walks one list. The fold of every group comes from the repository's
   * own state (remembered per root), so two sections fold apart.
   */
  protected readonly views = computed<RepoView[]>(() =>
    this.repos().map((state) => this.viewOf(state)),
  );

  /** The path of the one open repository, or `undefined` when all are folded. */
  protected readonly openPath = this.git.openPath;
  /** The open repository's Changes fold, from the shell (one panel, one fold). */
  protected readonly changesCollapsed = this.shell.gitChangesCollapsed;

  private viewOf(state: GitRepoState): RepoView {
    const staged = this.changesFor(state, 'staged');
    const changedCount = state.status()?.isRepo ? (state.status()?.files.length ?? 0) : 0;
    const groups = this.changeGroupsFor(state);
    return {
      state,
      path: state.info.path,
      changedCount,
      changeGroups: groups,
      matchingCount: groups.reduce((total, group) => total + group.rows.length, 0),
      stagedLabel: changedCount === 0 ? undefined : `${staged.length} of ${changedCount} staged`,
      canCommit:
        this.messageFor(state).trim().length > 0 && staged.length > 0 && !state.committing(),
    };
  }

  /** The two groups, filtered by the reader's path query. */
  private changeGroupsFor(state: GitRepoState): ChangeGroupView[] {
    const query = this.changeFilter().trim().toLowerCase();
    const pick = (rows: readonly ChangeView[]): readonly ChangeView[] =>
      query.length === 0
        ? rows
        : rows.filter((row) => row.path.toLowerCase().includes(query));
    return [
      {
        id: 'staged',
        label: 'Staged',
        rows: pick(this.changesFor(state, 'staged')),
        collapsed: state.stagedCollapsed(),
      },
      {
        id: 'unstaged',
        label: 'Unstaged',
        rows: pick(this.changesFor(state, 'unstaged')),
        collapsed: state.unstagedCollapsed(),
      },
    ];
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


  private readonly injector = inject(Injector);

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

  /**
   * Opens one repository, folding whichever was open; clicking it again folds it.
   * A crowded list then brings the opened detail into view: its header may sit below
   * the fold, and a detail that opens off-screen reads as no reaction at all.
   */
  protected toggleSection(path: string, event: Event): void {
    this.git.toggleSection(path);
    if (this.git.openPath() !== path) {
      return;
    }
    const header = (event.currentTarget as HTMLElement | null)?.closest('.repo-head');
    if (!(header instanceof HTMLElement)) {
      return;
    }
    afterNextRender(
      () => {
        const body = header.closest('.body');
        const detail = body?.querySelector('.repo-detail-pane');
        if (!(body instanceof HTMLElement) || !(detail instanceof HTMLElement)) {
          return;
        }
        const view = body.getBoundingClientRect();
        if (detail.getBoundingClientRect().bottom <= view.bottom) {
          return;
        }
        // The detail would open below the fold: pin its header to the top of the
        // scroll region, which is the most of the detail the panel can show.
        body.scrollTop += header.getBoundingClientRect().top - view.top;
      },
      { injector: this.injector },
    );
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

  /**
   * Lazy paging: near the end of what is loaded, ask for the next page, so the
   * list walks all the way back to the root commit as the reader scrolls.
   */
  protected close(): void {
    this.layout.setVisible('right', false);
  }

  /** The shared tree reports the node it was given; a group folds, a file opens. */
  /** Opens a changed path in a preview tab. */
  protected onOpenChange(state: GitRepoState, change: ChangeView): void {
    this.tabs.openFile(change.path, undefined, state.info.path || undefined);
  }

  /** A group header folds its section, from the repository's own flag. */
  protected onToggleChangeGroup(state: GitRepoState, group: ChangeGroupView): void {
    if (group.id === 'staged') {
      state.toggleStaged();
    } else {
      state.toggleUnstaged();
    }
  }

  /** The header's +/-: stage or unstage every row in the group. */
  protected onToggleChangeAll(state: GitRepoState, group: ChangeGroupView): void {
    if (group.id === 'staged') {
      this.unstageAll(state);
    } else {
      this.stageAll(state);
    }
  }

  /** A row's checkbox: checked stages, unchecked unstages. */
  protected onToggleChangeRow(
    state: GitRepoState,
    event: { path: string; staged: boolean },
  ): void {
    if (event.staged) {
      this.stage(state, event.path);
    } else {
      this.unstage(state, event.path);
    }
  }

  protected onChangeFilter(event: Event): void {
    this.changeFilter.set((event.target as HTMLInputElement).value);
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

}
