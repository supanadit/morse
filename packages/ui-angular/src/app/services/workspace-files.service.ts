import { Injectable, computed, effect, inject } from '@angular/core';
import type { GitStatus } from '@morse/protocol';
import { asGitStatus } from '@morse/ui-runtime';
import { MorseService } from '../host/morse.service';
import { WorkspaceFilesStore } from '../state/workspace-files.store';

/**
 * How often the Explorer and the `@` picker re-read the working tree. The tree
 * changes on disk, not through the wire, so a file added or deleted has to be
 * noticed by asking again — there is no host push for it.
 */
const POLL_MS = 4_000;

/**
 * The longest a file list may go without a real re-read, however quiet git says
 * the tree is. A safety net rather than a schedule: it exists so a case the
 * status signature does not capture heals itself instead of staying wrong.
 */
const LIST_MAX_AGE_MS = 60_000;

/**
 * The host's workspace files and their git status, read from the host.
 *
 * It is requested as soon as a host that can list files is ready, not when a
 * picker opens: waiting for a workspace walk after a click is what makes a picker
 * feel broken, and the list is small enough to hold. A timer then re-reads the
 * working tree, so neither surface needs a server restart.
 *
 * The poll asks for the working tree every tick, but re-indexes the file list
 * only when the tree actually moved (see `needsFreshList`). Asking the host for
 * fresh files makes it re-scan the whole directory, and for a tree that has not
 * changed that re-scan — not the status it was paired with — was what the poll
 * cost.
 *
 * The data itself lives in `WorkspaceFilesStore`; this service only decides when
 * to read it and writes the answer down.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceFiles {
  private readonly morse = inject(MorseService);
  private readonly store = inject(WorkspaceFilesStore);
  /** The cwd the cached list belongs to; a global host can switch projects. */
  private loadedFor: string | undefined;
  private inFlight = false;
  /** When the list was last re-read from disk, for the staleness cap. */
  private listReadAt = 0;
  /** The working tree of the last tick, to tell a change from a quiet poll. */
  private statusSignature: string | undefined;

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
      const handle = setInterval(() => this.poll(), POLL_MS);
      onCleanup(() => clearInterval(handle));
    });
  }

  /**
   * One poll tick. A hidden tab has nobody watching, so it skips the round trip
   * instead of re-indexing a tree no one is looking at.
   */
  private poll(): void {
    const doc = (globalThis as { document?: Document }).document;
    if (doc?.hidden === true) {
      return;
    }
    this.load(this.needsFreshList(), true);
  }

  /**
   * Whether the file list has to be re-indexed this tick.
   *
   * The polled working tree is the change signal: adding, editing, deleting or
   * renaming a path moves git's porcelain listing, which the host answers in one
   * cheap call — and a listing the host already has cannot name a file the
   * listing itself would have to show. Everything that signal cannot decide
   * keeps asking for a real re-read: a host with no git at all (VS Code), a
   * directory that is not a repository (there the list comes from a walk), and a
   * status the host did not answer.
   */
  private needsFreshList(): boolean {
    if (!this.gitAvailable()) {
      return true;
    }
    const status = this.store.status();
    if (status?.isRepo !== true) {
      return true;
    }
    if (Date.now() - this.listReadAt >= LIST_MAX_AGE_MS) {
      return true;
    }
    return workingTreeSignature(status) !== this.statusSignature;
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
    this.store.setStatus(status);
    return true;
  }

  /**
   * Loads the list if it is missing or stale; safe to call repeatedly. A
   * background poll does not raise `busy`, so neither surface flashes a spinner
   * every few seconds while nothing the reader asked for is pending.
   */
  ensureLoaded(force = false, background = false): void {
    if (!force && this.loadedFor === this.morse.workspace().cwd) {
      return;
    }
    // A forced load is a reader asking for the tree as it is now (a picker
    // opening, the Explorer's refresh button), so it re-indexes; an unforced one
    // may take the host's cached index.
    this.load(force, background);
  }

  /**
   * Reads the working tree and, when `listFresh`, the file list as it is on disk
   * right now — otherwise the host may answer the list from its own index. Both
   * are asked together, so the list and the badges describe the same moment.
   */
  private load(listFresh: boolean, background: boolean): void {
    const cwd = this.morse.workspace().cwd;
    if (cwd.length === 0 || this.inFlight) {
      return;
    }
    this.inFlight = true;
    if (!background) {
      this.store.setBusy(true);
      this.store.setError(undefined);
    }
    void Promise.all([
      this.morse.requestHostCommand('listFiles', listFresh ? { fresh: true } : undefined),
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
          this.store.setError('Could not list this project.');
          return;
        }
        const status = asGitStatus(statusData);
        this.loadedFor = cwd;
        this.store.setFiles(files);
        this.store.setStatus(status);
        if (listFresh) {
          this.listReadAt = Date.now();
        }
        // Recorded from what was just read, so the next tick compares against
        // the tree this answer described.
        this.statusSignature = status === undefined ? undefined : workingTreeSignature(status);
      })
      .finally(() => {
        this.inFlight = false;
        if (!background) {
          this.store.setBusy(false);
        }
        if (this.morse.workspace().cwd !== cwd) {
          this.ensureLoaded(true);
        }
      });
  }
}

/**
 * The working tree as one comparable string: every entry's status and path, in
 * the order git listed them (porcelain is sorted by path). Two ticks with the
 * same string describe the same tree, which is what makes a quiet poll cheap.
 */
function workingTreeSignature(status: GitStatus): string {
  return status.files.map((file) => `${file.status}:${file.path}`).join('|');
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
