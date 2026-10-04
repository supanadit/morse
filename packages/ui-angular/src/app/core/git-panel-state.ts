import { computed, inject, Injectable, signal } from '@angular/core';
import type { GitBranches, GitCommit, GitLog, GitMutation, GitSync } from '@morse/protocol';
import { MorseService } from './morse.service';
import { WorkspaceFiles } from './workspace-files';

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
 * The browser host's git panel data: the active project's commits and branch,
 * fetched with the `gitLog` host command a page at a time.
 *
 * `refresh()` loads the first page (a project switch, the refresh button);
 * `loadMore()` appends the next page as the panel scrolls, so the list walks all
 * the way back to the root commit without loading a huge history up front.
 */
@Injectable({ providedIn: 'root' })
export class GitPanelState {
  private readonly morse = inject(MorseService);
  private readonly workspace = inject(WorkspaceFiles);
  private readonly items = signal<GitCommit[]>([]);
  private readonly meta = signal<GitMeta | undefined>(undefined);
  private readonly busy = signal(false);
  private readonly failure = signal<string | undefined>(undefined);
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
  /** How far HEAD is from its upstream, for the pull/push controls. */
  private readonly syncState = signal<GitSync | undefined>(undefined);
  private readonly syncing = signal(false);
  readonly sync = this.syncState.asReadonly();
  /** True while a pull or push is in flight, so the buttons stay disabled. */
  readonly syncingNow = this.syncing.asReadonly();
  readonly ahead = computed(() => this.syncState()?.ahead ?? 0);
  readonly behind = computed(() => this.syncState()?.behind ?? 0);
  readonly upstream = computed(() => this.syncState()?.upstream);
  /** The branches the picker can switch to, read when it opens. */
  private readonly branchList = signal<GitBranches | undefined>(undefined);
  private readonly commitPending = signal(false);
  private readonly branchPending = signal(false);
  private readonly feedback = signal<{ ok: boolean; text: string } | undefined>(undefined);
  readonly branches = this.branchList.asReadonly();
  /** True while a commit is in flight, so the button stays disabled. */
  readonly committing = this.commitPending.asReadonly();
  /** True while a checkout is in flight. */
  readonly switching = this.branchPending.asReadonly();
  /** The last mutation's words, so a refusal is visible instead of silent. */
  readonly notice = this.feedback.asReadonly();

  refresh(): void {
    const cwd = this.morse.workspace().cwd;
    if (!cwd) {
      return;
    }
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

  /** Re-reads how far HEAD is from its upstream (a project switch, a refresh). */
  refreshSync(): void {
    const cwd = this.morse.workspace().cwd;
    if (!cwd) {
      return;
    }
    void this.morse.requestHostCommand('gitSync').then((data) => {
      const sync = asGitSync(data);
      if (sync !== undefined) {
        this.syncState.set(sync);
      }
    });
  }

  /** Reads the branches the picker lists; called when the picker opens. */
  loadBranches(): void {
    const cwd = this.morse.workspace().cwd;
    if (!cwd) {
      return;
    }
    void this.morse.requestHostCommand('gitBranches').then((data) => {
      const branches = asGitBranches(data);
      if (branches !== undefined) {
        this.branchList.set(branches);
      }
    });
  }

  /** Commits what is staged; the changes list, graph and distance all move. */
  async commit(message: string): Promise<boolean> {
    if (this.commitPending()) {
      return false;
    }
    this.commitPending.set(true);
    this.feedback.set(undefined);
    try {
      const data = await this.morse.requestHostCommand('gitCommit', { message }, 60_000);
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
        { branch, create },
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

  /** Pulls the upstream into the branch, then re-reads history and the distance. */
  async pull(): Promise<void> {
    await this.syncFrom('gitPull');
  }

  /** Pushes the branch to its upstream, then re-reads history and the distance. */
  async push(): Promise<void> {
    await this.syncFrom('gitPush');
  }

  /**
   * A pull/push is a network round trip, so it gets a long answer timeout (the
   * frontend's default 5s would give up while git is still talking), and the
   * history is re-read afterwards because the graph just changed.
   */
  private async syncFrom(command: 'gitPull' | 'gitPush'): Promise<void> {
    if (this.syncing()) {
      return;
    }
    this.syncing.set(true);
    try {
      const data = await this.morse.requestHostCommand(command, undefined, 180_000);
      const sync = asGitSync(data);
      if (sync !== undefined) {
        this.syncState.set(sync);
      }
      this.refresh();
    } finally {
      this.syncing.set(false);
    }
  }

  private async page(skip: number): Promise<GitLog | undefined> {
    const raw = await this.morse.requestHostCommand('gitLog', {
      max: GIT_PAGE_SIZE,
      skip,
    });
    return asGitLog(raw);
  }
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
