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
      this.morse.requestHostCommand('gitStatus'),
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
