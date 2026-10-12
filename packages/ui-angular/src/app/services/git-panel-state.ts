import { computed, inject, Injectable, signal, type Signal } from '@angular/core';
import type {
  GitBranches,
  GitCommit,
  GitLog,
  GitMutation,
  GitRepoInfo,
  GitStatus,
  GitSync,
} from '@morse/protocol';
import { asGitRepos, asGitStatus } from '@morse/ui-runtime';
import { MorseService } from '../host/morse.service';
import { WorkspaceFiles } from './workspace-files.service';
import { WorkspaceFilesStore } from '../state/workspace-files.store';

/** Commits per `gitLog` call; the panel appends another page as it scrolls. */
export const GIT_PAGE_SIZE = 250;

interface GitMeta {
  isRepo: boolean;
  root?: string;
  branch?: string;
  /** A full page came back, so there is likely more history below. */
  hasMore: boolean;
}

/**
 * One repository's git panel data and actions. A project may hold several
 * repositories — its own plus nested ones (a submodule, a separate checkout) —
 * so each gets its own state and sends its own `repo` argument, and stage,
 * commit, checkout, pull and push all act on the repository the row belongs to.
 *
 * `path` is the repository root relative to the viewing session's directory,
 * `''` for the session's own repository. It travels as the `repo` argument so
 * the host runs the command in the right working tree.
 */
export class GitRepoState {
  private readonly items = signal<GitCommit[]>([]);
  private readonly meta = signal<GitMeta | undefined>(undefined);
  private readonly busy = signal(false);
  private readonly failure = signal<string | undefined>(undefined);
  private readonly syncState = signal<GitSync | undefined>(undefined);
  private readonly syncing = signal(false);
  private readonly branchList = signal<GitBranches | undefined>(undefined);
  private readonly commitPending = signal(false);
  private readonly branchPending = signal(false);
  private readonly feedback = signal<{ ok: boolean; text: string } | undefined>(undefined);
  /** Bumped by every `refresh`, so a late page from an old project is dropped. */
  private generation = 0;

  readonly loading = this.busy.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly isRepo = computed(() => this.meta()?.isRepo === true);
  /** True once a project answered, even if it is not a repository. */
  readonly loaded = computed(() => this.meta() !== undefined);
  readonly branch = computed(() => this.meta()?.branch);
  readonly root = computed(() => this.meta()?.root);
  readonly hasMore = computed(() => this.meta()?.hasMore === true);
  readonly commits = this.items.asReadonly();
  /** The working tree's changes, polled while the panel is open. */
  /**
   * The working tree, read from the shared `WorkspaceFiles` poll rather than a
   * private copy: that poll already refreshes every repository every few seconds,
   * so the panel's changes list stays live without a second timer.
   */
  readonly status: Signal<GitStatus | undefined>;
  readonly ahead = computed(() => this.syncState()?.ahead ?? 0);
  readonly behind = computed(() => this.syncState()?.behind ?? 0);
  readonly upstream = computed(() => this.syncState()?.upstream);
  readonly syncingNow = this.syncing.asReadonly();
  readonly branches = this.branchList.asReadonly();
  /** True while a commit is in flight, so the button stays disabled. */
  readonly committing = this.commitPending.asReadonly();
  /** True while a checkout is in flight. */
  readonly switching = this.branchPending.asReadonly();
  /** The last mutation's words, so a refusal is visible instead of silent. */
  readonly notice = this.feedback.asReadonly();

  constructor(
    private readonly morse: MorseService,
    private readonly workspace: WorkspaceFiles,
    private readonly workspaceStore: WorkspaceFilesStore,
    readonly info: GitRepoInfo,
  ) {
    this.status = computed(() => this.workspaceStore.repos()[this.info.path]);
    this.stagedFold = signal(readFold(`morse.git.staged.${this.info.root}`));
    this.unstagedFold = signal(readFold(`morse.git.unstaged.${this.info.root}`));
    this.historyFold = signal(readFold(`morse.git.history.${this.info.root}`));
    this.stagedCollapsed = this.stagedFold.asReadonly();
    this.unstagedCollapsed = this.unstagedFold.asReadonly();
    this.historyCollapsed = this.historyFold.asReadonly();
  }

  /** The `repo` argument of every host command targeting this repository. */
  private get repoArg(): string | undefined {
    return this.info.path.length > 0 ? this.info.path : undefined;
  }

  /**
   * The three inner folds, each remembered per repository (keyed by its absolute
   * root) so a project switch does not lose them. Which *section* is open is not
   * here: only one repository is open at a time, and that is the panel's choice,
   * not a repository's (see `GitPanelState.openPath`).
   */
  private readonly stagedFold: ReturnType<typeof signal<boolean>>;
  private readonly unstagedFold: ReturnType<typeof signal<boolean>>;
  private readonly historyFold: ReturnType<typeof signal<boolean>>;
  readonly stagedCollapsed: Signal<boolean>;
  readonly unstagedCollapsed: Signal<boolean>;
  readonly historyCollapsed: Signal<boolean>;

  toggleStaged(): void {
    this.stagedFold.update((value) => !value);
    storeFold(`morse.git.staged.${this.info.root}`, this.stagedFold());
  }

  toggleUnstaged(): void {
    this.unstagedFold.update((value) => !value);
    storeFold(`morse.git.unstaged.${this.info.root}`, this.unstagedFold());
  }

  toggleHistory(): void {
    this.historyFold.update((value) => !value);
    storeFold(`morse.git.history.${this.info.root}`, this.historyFold());
  }

  /** Loads the first page of history and the sync distance. */
  refresh(): void {
    const generation = (this.generation += 1);
    this.busy.set(true);
    this.failure.set(undefined);
    this.refreshSync();
    void this.page(0)
      .then((result) => {
        if (generation !== this.generation) {
          return;
        }
        if (result === undefined) {
          this.items.set([]);
          this.meta.set(undefined);
          this.failure.set('The host could not read git history for this project.');
          return;
        }
        this.items.set(result.commits);
        this.meta.set(metaOf(result));
      })
      .finally(() => {
        if (generation === this.generation) {
          this.busy.set(false);
        }
      });
  }

  /** Re-reads the working tree for this repository. */
  loadStatus(): void {
    void this.morse.requestHostCommand('gitStatus', this.args()).then((data) => {
      const status = asGitStatus(data);
      if (status !== undefined) {
        this.workspaceStore.setStatus(this.info.path, status);
      }
    });
  }

  /** Appends the next page; a no-op while one is already in flight. */
  loadMore(): void {
    if (this.busy() || !this.hasMore() || !this.isRepo()) {
      return;
    }
    const generation = this.generation;
    const skip = this.items().length;
    this.busy.set(true);
    void this.page(skip)
      .then((result) => {
        if (generation !== this.generation || result === undefined) {
          return;
        }
        this.items.update((commits) => [...commits, ...result.commits]);
        this.meta.set(metaOf(result));
      })
      .finally(() => {
        if (generation === this.generation) {
          this.busy.set(false);
        }
      });
  }

  /** Re-reads how far HEAD is from its upstream. */
  refreshSync(): void {
    void this.morse.requestHostCommand('gitSync', this.args()).then((data) => {
      const sync = asGitSync(data);
      if (sync !== undefined) {
        this.syncState.set(sync);
      }
    });
  }

  /** Reads the branches the picker lists; called when the picker opens. */
  loadBranches(): void {
    const repo = this.repoArg;
    const request =
      repo === undefined
        ? this.morse.requestHostCommand('gitBranches')
        : this.morse.requestHostCommand('gitBranches', { repo });
    void request.then((data) => {
      const branches = asGitBranches(data);
      if (branches !== undefined) {
        this.branchList.set(branches);
      }
    });
  }

  /** Shows a refusal the host was never asked about (a client-side guard). */
  refuse(text: string): void {
    this.feedback.set({ ok: false, text });
  }

  /** Commits what is staged in this repository. */
  async commit(message: string): Promise<boolean> {
    if (this.commitPending()) {
      return false;
    }
    this.commitPending.set(true);
    this.feedback.set(undefined);
    try {
      const data = await this.morse.requestHostCommand(
        'gitCommit',
        { message, ...this.args() },
        60_000,
      );
      const result = asGitMutation(data);
      if (result?.ok === true) {
        this.workspace.refresh();
        this.refresh();
        return true;
      }
      this.feedback.set({ ok: false, text: result?.message ?? 'The commit did not go through.' });
      return false;
    } finally {
      this.commitPending.set(false);
    }
  }

  /** Switches branch (creating it first when asked), then re-reads everything. */
  async checkout(branch: string, create: boolean): Promise<boolean> {
    if (this.branchPending()) {
      return false;
    }
    this.branchPending.set(true);
    this.feedback.set(undefined);
    try {
      const data = await this.morse.requestHostCommand(
        'gitCheckout',
        { branch, create, ...this.args() },
        60_000,
      );
      const result = asGitMutation(data);
      if (result?.ok === true) {
        this.workspace.refresh();
        this.refresh();
        this.loadBranches();
        return true;
      }
      this.feedback.set({
        ok: false,
        text: result?.message ?? 'The branch switch did not go through.',
      });
      return false;
    } finally {
      this.branchPending.set(false);
    }
  }

  /** Pulls the upstream into this repository, then re-reads history and status. */
  async pull(): Promise<void> {
    await this.syncFrom('gitPull');
  }

  /** Pushes this repository's branch, then re-reads history and status. */
  async push(): Promise<void> {
    await this.syncFrom('gitPush');
  }

  /** Stages paths in this repository, taking the fresh working tree from the host. */
  async stage(paths: readonly string[]): Promise<void> {
    await this.workspace.stage(this.info.path, paths);
  }

  /** Unstages paths in this repository, keeping the working-tree change. */
  async unstage(paths: readonly string[]): Promise<void> {
    await this.workspace.unstage(this.info.path, paths);
  }

  private async syncFrom(command: 'gitPull' | 'gitPush'): Promise<void> {
    if (this.syncing()) {
      return;
    }
    this.syncing.set(true);
    try {
      const data = await this.morse.requestHostCommand(command, this.args(), 180_000);
      const sync = asGitSync(data);
      if (sync !== undefined) {
        this.syncState.set(sync);
      }
      this.workspace.refresh();
      this.refresh();
    } finally {
      this.syncing.set(false);
    }
  }

  private args(): Record<string, unknown> | undefined {
    const repo = this.repoArg;
    return repo === undefined ? undefined : { repo };
  }

  private async page(skip: number): Promise<GitLog | undefined> {
    const raw = await this.morse.requestHostCommand('gitLog', {
      max: GIT_PAGE_SIZE,
      skip,
      ...(this.args() ?? {}),
    });
    return asGitLog(raw);
  }
}

/**
 * The browser host's git panel data: the repositories under the active project,
 * each with its own history, working tree, branches and mutations. The panel
 * lists them as accordion sections, the way VS Code's source-control view does.
 *
 * `refresh()` re-reads the repository list (a project switch, the refresh
 * button) and refreshes each one; the nested repository set is discovered by the
 * host (`gitRepos`), so a submodule added since the last read shows up.
 */
@Injectable({ providedIn: 'root' })
export class GitPanelState {
  private readonly morse = inject(MorseService);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly workspaceStore = inject(WorkspaceFilesStore);
  private readonly sections = signal<GitRepoState[]>([]);
  private readonly discovered = signal(false);
  private readonly busy = signal(false);
  private readonly failure = signal<string | undefined>(undefined);
  /**
   * The repository whose section is open, by relative path. Only one is open at
   * a time — a pinned list + detail, the way the Explorer sits below the
   * session list — so the other repository headers stay visible and never need
   * to be scrolled to. `undefined` means every section is folded.
   */
  private readonly openPathSignal = signal<string | undefined>(readOpenRepo());

  /** Every repository under the project, the session's own first. */
  readonly repos = this.sections.asReadonly();
  /** The relative path of the open section, or `undefined` when all are folded. */
  readonly openPath = this.openPathSignal.asReadonly();
  readonly loading = this.busy.asReadonly();
  readonly error = this.failure.asReadonly();
  /** True once the host answered, even if the project holds no repository. */
  readonly loaded = computed(() => this.discovered());
  /** True when the project holds at least one repository. */
  readonly isRepo = computed(() => this.sections().length > 0);
  /** The repository the project's session directory sits in, when there is one. */
  readonly current = computed(
    () => this.sections().find((section) => section.info.current) ?? this.sections()[0],
  );

  /**
   * Opens one repository, folding whichever was open. Clicking the open one
   * again folds it, so the panel can show every header and nothing else.
   */
  toggleSection(path: string): void {
    this.setOpen(this.openPathSignal() === path ? undefined : path);
  }

  /** Opens one repository's section directly. */
  open(path: string): void {
    this.setOpen(path);
  }

  private setOpen(path: string | undefined): void {
    this.openPathSignal.set(path);
    storeOpenRepo(path);
  }

  /** Re-reads the repository list and every repository's history. */
  refresh(): void {
    const cwd = this.morse.workspace().cwd;
    if (!cwd) {
      return;
    }
    this.busy.set(true);
    this.failure.set(undefined);
    void this.morse
      .requestHostCommand('gitRepos')
      .then((data) => {
        const repos = asGitRepos(data);
        if (repos === undefined) {
          this.sections.set([]);
          this.failure.set('The host could not read git history for this project.');
          return;
        }
        this.discovered.set(true);
        // Reuse the state of a repository that is still present, so its loaded
        // history and fold are not thrown away by a refresh; refresh the rest.
        // Keyed by the repository's absolute root *and* its relative path, not
        // the path alone: a project's own repository is `''` in *every* project,
        // so keying by path made a project switch keep the previous project's
        // repo — its stale name, branch and root — while only history refreshed.
        // The root alone would miss the same repo reached by a different
        // relative path (its own repo in one project, a nested one in another),
        // whose commands need the path that project expects.
        const previous = new Map(this.sections().map((state) => [repoKey(state.info), state]));
        const next = repos.repos.map(
          (info) =>
            previous.get(repoKey(info)) ??
            new GitRepoState(this.morse, this.workspace, this.workspaceStore, info),
        );
        this.sections.set(next);
        // The remembered open section may be gone (a project switch), or never
        // chosen on a first visit; fall back to the session's own repository so
        // the panel opens on something useful, never a blank detail pane.
        if (!next.some((state) => state.info.path === this.openPathSignal())) {
          this.setOpen(next.find((state) => state.info.current)?.info.path ?? next[0]?.info.path);
        }
        for (const state of next) {
          state.refresh();
          state.loadStatus();
        }
      })
      .finally(() => {
        this.busy.set(false);
      });
  }

  /** Re-reads every repository's working tree (the panel's poll tick). */
  refreshStatuses(): void {
    for (const state of this.sections()) {
      state.loadStatus();
    }
  }

  /** The state for one repository path (`''` for the session's own). */
  stateFor(path: string): GitRepoState | undefined {
    return this.sections().find((state) => state.info.path === path);
  }
}

/**
 * The identity of one repository within the panel: its absolute root and the
 * relative path the current project addresses it by. Two projects reach the same
 * repository at different relative paths (`''` for their own), so both are needed
 * to tell a genuinely unchanged repository from a different one that happens to
 * share a relative path.
 */
function repoKey(info: GitRepoInfo): string {
  return `${info.root}\u0000${info.path}`;
}

function metaOf(log: GitLog): GitMeta {
  return {
    isRepo: log.isRepo,
    root: log.root,
    branch: log.branch,
    // A short page is the end of the history (the root commit).
    hasMore: log.commits.length === GIT_PAGE_SIZE,
  };
}

/** Validates the host's answer: a host command reply is `unknown` on the wire. */
export function asGitLog(value: unknown): GitLog | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['isRepo'] !== true) {
    return typeof candidate['isRepo'] === 'boolean' ? { isRepo: false, commits: [] } : undefined;
  }
  const commits = Array.isArray(candidate['commits'])
    ? candidate['commits'].map(asCommit).filter((commit): commit is GitCommit => commit !== undefined)
    : [];
  return {
    isRepo: true,
    root: typeof candidate['root'] === 'string' ? candidate['root'] : undefined,
    branch: typeof candidate['branch'] === 'string' ? candidate['branch'] : undefined,
    commits,
  };
}

function asCommit(value: unknown): GitCommit | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const commit = value as Record<string, unknown>;
  const hash = commit['hash'];
  const shortHash = commit['shortHash'];
  if (typeof hash !== 'string' || typeof shortHash !== 'string') {
    return undefined;
  }
  return {
    hash,
    shortHash,
    parents: stringList(commit['parents']),
    refs: stringList(commit['refs']),
    author: typeof commit['author'] === 'string' ? commit['author'] : '',
    date: typeof commit['date'] === 'string' ? commit['date'] : '',
    subject: typeof commit['subject'] === 'string' ? commit['subject'] : '',
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Validates the host's answer to `gitSync`. */
export function asGitSync(value: unknown): GitSync | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['isRepo'] !== 'boolean') {
    return undefined;
  }
  return {
    isRepo: candidate['isRepo'],
    branch: typeof candidate['branch'] === 'string' ? candidate['branch'] : undefined,
    upstream: typeof candidate['upstream'] === 'string' ? candidate['upstream'] : undefined,
    ahead: count(candidate['ahead']),
    behind: count(candidate['behind']),
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Whether a per-repository fold was left collapsed, from `localStorage`. */
function readFold(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function storeFold(key: string, collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, collapsed ? '1' : '0');
  } catch {
    // A host without storage simply forgets the fold.
  }
}

/** The repository path whose section was left open, from `localStorage`. */
function readOpenRepo(): string | undefined {
  try {
    const value = globalThis.localStorage?.getItem(OPEN_REPO_KEY);
    return value === null || value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

function storeOpenRepo(path: string | undefined): void {
  try {
    if (path === undefined) {
      globalThis.localStorage?.removeItem(OPEN_REPO_KEY);
      return;
    }
    globalThis.localStorage?.setItem(OPEN_REPO_KEY, path);
  } catch {
    // A host without storage simply forgets the open section.
  }
}

/** The key the open repository's relative path is remembered under. */
const OPEN_REPO_KEY = 'morse.git.openRepo';

/** Validates the host's answer to `gitBranches`. */
export function asGitBranches(value: unknown): GitBranches | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['isRepo'] !== 'boolean') {
    return undefined;
  }
  return {
    isRepo: candidate['isRepo'],
    current: typeof candidate['current'] === 'string' ? candidate['current'] : undefined,
    local: stringList(candidate['local']),
    remote: stringList(candidate['remote']),
    tags: stringList(candidate['tags']),
  };
}

/** Validates the host's answer to a mutation (`gitCommit`, `gitCheckout`). */
export function asGitMutation(value: unknown): GitMutation | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['ok'] !== 'boolean') {
    return undefined;
  }
  return {
    ok: candidate['ok'],
    message: typeof candidate['message'] === 'string' ? candidate['message'] : undefined,
  };
}
