import { computed, inject, Injectable, signal } from '@angular/core';
import type { GitCommit, GitLog } from '@morse/protocol';
import { MorseService } from './morse.service';

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

  refresh(): void {
    const cwd = this.morse.workspace().cwd;
    if (!cwd) {
      return;
    }
    const generation = (this.generation += 1);
    this.busy.set(true);
    this.failure.set(undefined);
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
