import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { GitStatus } from '@morse/protocol';
import { asGitStatus } from './git-status';
import { MorseService } from './morse.service';

/**
 * How often the Explorer and the `@` picker re-read the working tree. The tree
 * changes on disk, not through the wire, so a file added or deleted has to be
 * noticed by asking again — there is no host push for it.
 */
const POLL_MS = 4_000;

/**
 * The host's workspace files and their git status, shared by the Explorer and
 * the composer's `@mention` picker.
 *
 * It is requested as soon as a host that can list files is ready, not when a
 * picker opens: waiting for a workspace walk after a click is what makes a picker
 * feel broken, and the list is small enough to hold. A timer then re-reads both
 * `listFiles` (bypassing the host's index cache) and `gitStatus`, so the two
 * always describe the same moment and neither needs a server restart.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceFiles {
  private readonly morse = inject(MorseService);
  private readonly cache = signal<string[]>([]);
  private readonly loading = signal(false);
  private readonly statuses = signal<GitStatus | undefined>(undefined);
  private readonly failure = signal<string | undefined>(undefined);
  /** The cwd the cached list belongs to; a global host can switch projects. */
  private loadedFor: string | undefined;
  private inFlight = false;

  readonly files = this.cache.asReadonly();
  readonly busy = this.loading.asReadonly();
  readonly status = this.statuses.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly available = computed(() => this.morse.capabilities()?.filePicker === true);
  /**
   * Whether the host answers for git at all. The `@` picker only needs the file
   * list, but the Explorer's badges and the git panel's changes list need the
   * working tree — and only the browser host implements `gitStatus`. VS Code
   * keeps its own Source Control and leaves `gitPanel` off, so asking it anyway
   * put a "VS Code does not implement \"gitStatus\"" error in the transcript on
   * every poll. Same capability the git panel itself is gated on.
   */
  readonly gitAvailable = computed(() => this.morse.capabilities()?.gitPanel === true);

  constructor() {
    effect(() => {
      if (!this.available()) {
        return;
      }
      const cwd = this.morse.workspace().cwd;
      // The browser host is global: switching projects must not keep offering
      // the previous project's files to the `@` picker.
      this.ensureLoaded(this.loadedFor !== undefined && this.loadedFor !== cwd);
    });

    effect((onCleanup) => {
      if (!this.available()) {
        return;
      }
      const handle = setInterval(() => {
        // A hidden tab has nobody watching; skip the walk until it is visible.
        if (typeof document !== 'undefined' && document.hidden) {
          return;
        }
        this.ensureLoaded(true, true);
      }, POLL_MS);
      onCleanup(() => clearInterval(handle));
    });
  }

  /** Forces a re-read now (the Explorer's refresh button). */
  refresh(): void {
    this.ensureLoaded(true);
  }

  /**
   * Stages the named paths in the viewing session's repository. The host answers
   * with the fresh working tree, so the panel updates without a second poll; a
   * host that cannot answer leaves the status to resync instead.
   */
  async stage(paths: readonly string[]): Promise<boolean> {
    return this.mutate('gitStage', paths);
  }

  /** Unstages the named paths, keeping the working-tree change. */
  async unstage(paths: readonly string[]): Promise<boolean> {
    return this.mutate('gitUnstage', paths);
  }

  private async mutate(
    command: 'gitStage' | 'gitUnstage',
    paths: readonly string[],
  ): Promise<boolean> {
    if (paths.length === 0) {
      return true;
    }
    const result = await this.morse.requestHostCommand(command, { paths: [...paths] });
    const status = asGitStatus(result);
    if (status === undefined) {
      // No usable answer (an older host): fall back to a full resync so the
      // panel is not left showing a state that is no longer true.
      this.refresh();
      return false;
    }
    this.statuses.set(status);
    return true;
  }

  /**
   * Loads the list if it is missing or stale; safe to call repeatedly. A
   * background poll does not raise `busy`, so neither surface flashes a spinner
   * every few seconds while nothing the reader asked for is pending.
   */
  ensureLoaded(force = false, background = false): void {
    const cwd = this.morse.workspace().cwd;
    if (cwd.length === 0 || this.inFlight) {
      return;
    }
    if (!force && this.loadedFor === cwd) {
      return;
    }
    this.inFlight = true;
    if (!background) {
      this.loading.set(true);
      this.failure.set(undefined);
    }
    void Promise.all([
      this.morse.requestHostCommand('listFiles', force ? { fresh: true } : undefined),
      // A host without git (VS Code) is never asked: it would answer with an
      // error, and a background poll must not fill the transcript with those.
      this.gitAvailable()
        ? this.morse.requestHostCommand('gitStatus')
        : Promise.resolve(undefined),
    ])
      .then(([listData, statusData]) => {
        if (this.morse.workspace().cwd !== cwd) {
          // The project changed while this request was in flight; the next poll
          // (or the effect) asks again for the directory the user is in.
          return;
        }
        const files = asFiles(listData);
        if (files === undefined) {
          this.failure.set('Could not list this project.');
          return;
        }
        this.loadedFor = cwd;
        this.cache.set(files);
        this.statuses.set(asGitStatus(statusData));
      })
      .finally(() => {
        this.inFlight = false;
        if (!background) {
          this.loading.set(false);
        }
        if (this.morse.workspace().cwd !== cwd) {
          this.ensureLoaded(true);
        }
      });
  }
}

function asFiles(value: unknown): string[] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return undefined;
  }
  return files.filter((file): file is string => typeof file === 'string');
}
