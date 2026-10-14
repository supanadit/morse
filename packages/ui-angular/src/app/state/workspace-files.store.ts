import { Injectable, computed, signal } from '@angular/core';
import type { GitStatus } from '@morse/protocol';

/**
 * The host's workspace file list and its git status, as data.
 *
 * The store owns the signals; the timer and the host calls that fill them live
 * in `services/workspace-files.service.ts`. Keeping the two apart lets a surface
 * read the tree — the Explorer's badges, the `@` picker, the preview's header —
 * without dragging the poll along with it.
 *
 * A project can hold several repositories, so the working tree is kept per
 * repository (keyed by the repository path relative to the session directory,
 * `''` for the session's own) and merged into one `status` for the Explorer and
 * the preview badges. The git panel reads the per-repository map directly, so a
 * nested repository's changes are its own section's.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceFilesStore {
  private readonly cache = signal<string[]>([]);
  private readonly loading = signal(false);
  private readonly statuses = signal<Record<string, GitStatus>>({});
  private readonly failure = signal<string | undefined>(undefined);
  private readonly levels = signal<Record<string, string[]>>({});
  private readonly asking = signal<ReadonlySet<string>>(new Set());

  readonly files = this.cache.asReadonly();
  readonly busy = this.loading.asReadonly();
  readonly error = this.failure.asReadonly();

  /**
   * The Explorer's lazy tree: the entries of every directory listed so far,
   * keyed by its cwd-relative path (`''` is the project root). The flat `files`
   * list stays what the picker and the filter rank; this is what makes every
   * level complete — the flat index is capped, these levels are read one
   * `readdir` at a time as their folders open.
   */
  readonly directories = this.levels.asReadonly();
  /** The directories whose level is on its way, for the row's loading mark. */
  readonly pendingDirectories = this.asking.asReadonly();

  /** The working tree of every repository, keyed by repository path. */
  readonly repos = this.statuses.asReadonly();

  /**
   * Every repository's changes as one status, for the Explorer's per-file
   * badges: a path from any repository is a changed path in the project. A
   * project whose repositories are all clean (or that holds none) reads as
   * `isRepo: false`, exactly as a single repository would have.
   */
  readonly status = computed<GitStatus | undefined>(() => {
    const repos = Object.entries(this.statuses());
    if (repos.length === 0) {
      return undefined;
    }
    const files = repos
      .filter(([, status]) => status.isRepo)
      .flatMap(([, status]) => status.files);
    return { isRepo: files.length > 0 || repos.some(([, s]) => s.isRepo), files };
  });

  /** The file list as of the last read. */
  setFiles(files: readonly string[]): void {
    this.cache.set([...files]);
  }

  /** Whether a reader-initiated read is in flight (a background poll is not). */
  setBusy(busy: boolean): void {
    this.loading.set(busy);
  }

  /** The working tree of one repository, keyed by its path (`''` for the own). */
  setStatus(path: string, status: GitStatus | undefined): void {
    this.statuses.update((map) => {
      if (status === undefined) {
        const { [path]: _removed, ...rest } = map;
        return rest;
      }
      return { ...map, [path]: status };
    });
  }

  /** Replaces the whole per-repository map (a fresh `gitRepos` round trip). */
  setStatuses(statuses: Record<string, GitStatus>): void {
    this.statuses.set({ ...statuses });
  }

  /** Why the last read failed, or `undefined` when it did not. */
  setError(error: string | undefined): void {
    this.failure.set(error);
  }

  /** One directory's level, as the host listed it. */
  setDirectory(path: string, entries: readonly string[]): void {
    this.levels.update((map) => ({ ...map, [path]: [...entries] }));
  }

  /** Whether one directory's level is being fetched right now. */
  setDirectoryPending(path: string, pending: boolean): void {
    this.asking.update((set) => {
      if (set.has(path) === pending) {
        return set;
      }
      const next = new Set(set);
      if (pending) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  }

  /**
   * Forgets every listed level: a project switch, the reader's refresh, or a
   * working tree that moved. The surfaces ask again for what they show — the
   * root level and the folders still open — so a level can never go stale for
   * longer than the signal that invalidated it.
   */
  invalidateDirectories(): void {
    this.levels.set({});
    this.asking.set(new Set());
  }
}
