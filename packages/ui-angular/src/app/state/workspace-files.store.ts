import { Injectable, signal } from '@angular/core';
import type { GitStatus } from '@morse/protocol';

/**
 * The host's workspace file list and its git status, as data.
 *
 * The store owns the signals; the timer and the host calls that fill them live
 * in `services/workspace-files.service.ts`. Keeping the two apart lets a surface
 * read the tree — the Explorer's badges, the `@` picker, the preview's header —
 * without dragging the poll along with it.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceFilesStore {
  private readonly cache = signal<string[]>([]);
  private readonly loading = signal(false);
  private readonly statuses = signal<GitStatus | undefined>(undefined);
  private readonly failure = signal<string | undefined>(undefined);

  readonly files = this.cache.asReadonly();
  readonly busy = this.loading.asReadonly();
  readonly status = this.statuses.asReadonly();
  readonly error = this.failure.asReadonly();

  /** The file list as of the last read. */
  setFiles(files: readonly string[]): void {
    this.cache.set([...files]);
  }

  /** Whether a reader-initiated read is in flight (a background poll is not). */
  setBusy(busy: boolean): void {
    this.loading.set(busy);
  }

  /** The working tree the last read answered with. */
  setStatus(status: GitStatus | undefined): void {
    this.statuses.set(status);
  }

  /** Why the last read failed, or `undefined` when it did not. */
  setError(error: string | undefined): void {
    this.failure.set(error);
  }
}
