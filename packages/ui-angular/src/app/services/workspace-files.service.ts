import { Injectable, computed, effect, inject } from '@angular/core';
import type { GitStatus } from '@morse/protocol';
import { asGitRepos, asGitStatus } from '@morse/ui-runtime';
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
 * The longest a listed directory level may stand without being read again.
 * A project switch, a moved file list and a moved working tree all throw the
 * levels away at once; this ceiling is for the staleness none of those signals
 * can see — a change past the flat list's cap, on a host with no git to ask.
 */
const LEVELS_MAX_AGE_MS = 60_000;

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
 *
 * The Explorer's tree also travels in levels (`listDir`): this service issues
 * those requests too, and decides when the levels already listed stop standing
 * for the disk — a file list that moved, a working tree that moved, a project
 * switch, or a minute of silence throws them away, and whatever is still open
 * is asked for again from scratch.
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
  /** The file list as one comparable string, the same tell for the flat listing. */
  private filesSignature: string | undefined;
  /**
   * The lazy tree's generation: bumped whenever its listed levels are thrown
   * away, so an answer asked for before the change lands as if it were never
   * asked — a stale level must not re-populate the cache a refresh just cleared.
   */
  private levelGeneration = 0;
  /** When the listed levels were last thrown away, for their staleness ceiling.
   *  Set at construction, so a first read is a baseline rather than a change. */
  private levelsInvalidatedAt = Date.now();

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
    // No verdict from the previous tick: `read` judges the status it just read.
    this.load(undefined, true);
  }

  /**
   * Whether the file list has to be re-indexed, judged from `status` — the
   * working tree this tick just read, not the one the last tick left behind.
   *
   * The polled working tree is the change signal: adding, editing, deleting or
   * renaming a path moves git's porcelain listing, which the host answers in one
   * cheap call — and a listing the host already has cannot name a file the
   * listing itself would have to show. Everything that signal cannot decide
   * keeps asking for a real re-read: a host with no git at all (VS Code), a
   * directory that is not a repository (there the list comes from a walk), and a
   * status the host did not answer.
   */
  private needsFreshList(status: GitStatus | undefined): boolean {
    if (!this.gitAvailable()) {
      return true;
    }
    if (status?.isRepo !== true) {
      return true;
    }
    if (Date.now() - this.listReadAt >= LIST_MAX_AGE_MS) {
      return true;
    }
    return workingTreeSignature(status) !== this.statusSignature;
  }

  /**
   * Forces a re-read now (the Explorer's refresh button). The levels the lazy
   * tree already listed go with it: the reader pressed refresh because what is
   * on screen may no longer be what is on disk.
   */
  refresh(): void {
    this.invalidateLevels();
    this.ensureLoaded(true);
  }

  /**
   * Stages the named paths in one repository of the viewing project. The host
   * answers with the fresh working tree, so the panel and the Explorer update
   * without a second poll; a host that cannot answer leaves the status to
   * resync instead.
   */
  async stage(repo: string, paths: readonly string[]): Promise<boolean> {
    return this.mutate('gitStage', repo, paths);
  }

  /** Unstages the named paths of one repository, keeping the working-tree change. */
  async unstage(repo: string, paths: readonly string[]): Promise<boolean> {
    return this.mutate('gitUnstage', repo, paths);
  }

  private async mutate(
    command: 'gitStage' | 'gitUnstage',
    repo: string,
    paths: readonly string[],
  ): Promise<boolean> {
    if (paths.length === 0) {
      return true;
    }
    const result = await this.morse.requestHostCommand(command, {
      paths: [...paths],
      ...(repo.length > 0 ? { repo } : {}),
    });
    const status = asGitStatus(result);
    if (status === undefined) {
      // No usable answer (an older host): fall back to a full resync so the
      // panel is not left showing a state that is no longer true.
      this.refresh();
      return false;
    }
    this.store.setStatus(repo, status);
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
   * Starts one round trip with the host. `listFresh` is the caller's verdict — a
   * reader opening a picker or pressing refresh already knows what it wants — or
   * `undefined` to let the working tree decide, which is what a poll tick wants.
   */
  private load(listFresh: boolean | undefined, background: boolean): void {
    const cwd = this.morse.workspace().cwd;
    if (cwd.length === 0 || this.inFlight) {
      return;
    }
    // A new project: its root level is not the old one's, whatever the old
    // listings said. (The read below checks again, for a switch mid-flight.)
    if (this.loadedFor !== undefined && this.loadedFor !== cwd) {
      this.invalidateLevels();
    }
    this.inFlight = true;
    if (!background) {
      this.store.setBusy(true);
      this.store.setError(undefined);
    }
    void this.read(cwd, listFresh, background);
  }

  /**
   * Reads the working tree of every repository and then the file list, so the
   * list and the badges describe the same moment.
   *
   * The order matters. The statuses are the change signal, so they are asked for
   * first: a tick that issued both commands together had to decide before the
   * statuses it was comparing had arrived, which made the list follow the tree a
   * whole tick — four seconds — after the tree had already moved.
   */
  private async read(
    cwd: string,
    listFresh: boolean | undefined,
    background: boolean,
  ): Promise<void> {
    try {
      // A host without git (VS Code) is never asked: it would answer with an
      // error, and a background poll must not fill the transcript with those.
      const statuses = this.gitAvailable() ? await this.readStatuses() : new Map<string, GitStatus>();
      if (this.morse.workspace().cwd !== cwd) {
        // The project changed while this request was in flight; the next poll
        // (or the effect) asks again for the directory the user is in.
        return;
      }
      const merged = this.mergeStatuses(statuses);
      const fresh = listFresh ?? this.needsFreshList(merged);
      const listData = await this.morse.requestHostCommand(
        'listFiles',
        fresh ? { fresh: true } : undefined,
      );
      if (this.morse.workspace().cwd !== cwd) {
        return;
      }
      const files = asFiles(listData);
      if (files === undefined) {
        this.store.setError('Could not list this project.');
        return;
      }
      /*
       * The lazy tree's levels answer to this moment. A project switch (a read
       * that landed on a different directory than the one it was asked for), a
       * file list that moved, or a working tree that moved throws them away; the
       * age ceiling covers the change no signal can see. The signatures start as
       * a baseline — the first read *is* the project, not a change in it — so the
       * root level asked for on mount is not thrown away before it lands.
       * Signatures are recorded from what was just read, so the next tick
       * compares against the tree this answer described.
       */
      const nextFilesSignature = files.join('\n');
      const nextStatusSignature = merged === undefined ? undefined : workingTreeSignature(merged);
      const moved =
        (this.loadedFor !== undefined && this.loadedFor !== cwd) ||
        (this.filesSignature !== undefined && nextFilesSignature !== this.filesSignature) ||
        (this.statusSignature !== undefined && nextStatusSignature !== this.statusSignature);
      if (moved || Date.now() - this.levelsInvalidatedAt >= LEVELS_MAX_AGE_MS) {
        this.invalidateLevels();
      }
      this.filesSignature = nextFilesSignature;
      this.loadedFor = cwd;
      this.store.setFiles(files);
      this.store.setStatuses(Object.fromEntries(statuses));
      if (fresh) {
        this.listReadAt = Date.now();
      }
      this.statusSignature = nextStatusSignature;
    } finally {
      this.inFlight = false;
      if (!background) {
        this.store.setBusy(false);
      }
      if (this.morse.workspace().cwd !== cwd) {
        this.ensureLoaded(true);
      }
    }
  }

  /**
   * Lists one level of the Explorer's lazy tree: the root, which the pane draws
   * first, or a folder opened for the first time. Safe to call repeatedly — a
   * level already listed, or already on its way, is left alone — which is what
   * lets the surface drive it from a plain "whatever is open has no level yet"
   * effect without asking twice.
   */
  loadDir(path: string): void {
    const cwd = this.morse.workspace().cwd;
    if (
      cwd.length === 0 ||
      !this.available() ||
      this.store.directories()[path] !== undefined ||
      this.store.pendingDirectories().has(path)
    ) {
      return;
    }
    const generation = this.levelGeneration;
    this.store.setDirectoryPending(path, true);
    void this.morse
      .requestHostCommand('listDir', path.length > 0 ? { path } : undefined)
      .then((data) => {
        if (generation !== this.levelGeneration || this.morse.workspace().cwd !== cwd) {
          return;
        }
        const entries = asDirEntries(data);
        if (entries !== undefined) {
          this.store.setDirectory(path, entries);
        }
      })
      .finally(() => {
        if (generation === this.levelGeneration) {
          this.store.setDirectoryPending(path, false);
        }
      });
  }

  /**
   * Throws the lazy tree's listed levels away: the signals say the tree moved,
   * the reader asked, or the project changed. The generation drops the requests
   * already on their way, so an answer from before the change cannot land as if
   * it were after it.
   */
  private invalidateLevels(): void {
    this.levelGeneration += 1;
    this.levelsInvalidatedAt = Date.now();
    this.store.invalidateDirectories();
  }

  /**
   * Reads every repository's working tree. The repository set comes from
   * `gitRepos` — the project's own plus any nested ones — and each is asked for
   * its own `gitStatus`, so the Explorer's badges cover a submodule's files too.
   * A host that cannot answer `gitRepos` falls back to the session's own
   * repository, so a single-repository host keeps working unchanged.
   */
  private async readStatuses(): Promise<Map<string, GitStatus>> {
    const statuses = new Map<string, GitStatus>();
    // Ask for the session's own repository immediately, so a host that answers
    // `gitRepos` slowly still gets its working tree in the same tick.
    const own = this.morse.requestHostCommand('gitStatus');
    // An older host answers `undefined` to `gitRepos`; then the session's own
    // repository is the only one there is.
    const repos = asGitRepos(await this.morse.requestHostCommand('gitRepos'));
    const nested = repos === undefined ? [] : repos.repos.filter((repo) => repo.path.length > 0);
    const ownStatus = asGitStatus(await own);
    if (ownStatus !== undefined && ownStatus.isRepo) {
      statuses.set('', ownStatus);
    }
    for (const repo of nested) {
      const status = asGitStatus(
        await this.morse.requestHostCommand('gitStatus', { repo: repo.path }),
      );
      if (status !== undefined && status.isRepo) {
        statuses.set(repo.path, status);
      }
    }
    return statuses;
  }

  /**
   * Every repository's changes as one status, matching what the store computes
   * for the Explorer. Used only as the change signal here: it is what
   * `needsFreshList` and the signature compare against.
   */
  private mergeStatuses(statuses: Map<string, GitStatus>): GitStatus | undefined {
    if (statuses.size === 0) {
      return undefined;
    }
    const files = [...statuses.values()].flatMap((status) => status.files);
    return { isRepo: true, files };
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

/** What `listDir` answers with: one directory's entries, in `listFiles`' vocabulary. */
function asDirEntries(value: unknown): string[] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return undefined;
  }
  return entries.filter((entry): entry is string => typeof entry === 'string');
}
