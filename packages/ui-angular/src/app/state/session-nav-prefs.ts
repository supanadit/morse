import { Injectable, inject, signal } from '@angular/core';
import { ViewState } from '../host/view-state';

/**
 * Which projects the reader shut, keyed by path. A project absent from the map is
 * open, so the map only grows the entries a reader made a decision about — and a
 * project that appears later starts unfolded, which is what a folder they just
 * created should do.
 */
export type ProjectFolds = Record<string, boolean>;

const FOLDS_KEY = 'sessionNav.folds';
const LIST_FOLDED_KEY = 'sessionNav.listFolded';

function isProjectFolds(value: unknown): value is ProjectFolds {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((flag) => typeof flag === 'boolean');
}

/**
 * The session list's folds, remembered.
 *
 * The list is a catalog: a reader with hundreds of projects does not want every
 * one of them unfolded on arrival, and a fold they took the trouble to make should
 * survive a reload. Both facts are theirs, not the host's — the same machine read
 * from a browser and from VS Code may want different ones — so they live here and
 * outlive the page through `ViewState` (`localStorage` in a browser, the webview's
 * own state in VS Code).
 *
 * The one default: until a reader has folds on record, a single project stays
 * unfolded — the nav picks it, see `seedFolds` — so a long catalog arrives
 * readable instead of as every session at once. That is not a fold of theirs, so
 * it is written the first time it is resolved rather than recomputed on every
 * visit — otherwise unfolding a project on the default would be forgotten, since
 * "absent means open" cannot tell a fold the reader undid from one they never made.
 */
@Injectable({ providedIn: 'root' })
export class SessionNavPrefs {
  private readonly viewState = inject(ViewState);

  /** What was on record at start-up; `undefined` means the reader has never folded. */
  private readonly storedFolds = this.viewState.read<ProjectFolds>(FOLDS_KEY);
  /** A stored value this build cannot read is no record at all, so the default applies. */
  private readonly storedIsFolds = isProjectFolds(this.storedFolds);

  private readonly foldsSignal = signal<ProjectFolds>(
    this.storedIsFolds ? (this.storedFolds as ProjectFolds) : {},
  );
  /** Folded projects, by path. Read it through `expandedProjects` in the nav. */
  readonly folds = this.foldsSignal.asReadonly();

  /** True once the reader's folds (or the resolved default) are on record. */
  private readonly rememberedSignal = signal(this.storedIsFolds);
  readonly remembered = this.rememberedSignal.asReadonly();

  private readonly listFoldedSignal = signal(this.viewState.read<boolean>(LIST_FOLDED_KEY) === true);
  /** The whole list folded away to its title bar, the way the Explorer folds. */
  readonly listFolded = this.listFoldedSignal.asReadonly();

  setListFolded(folded: boolean): void {
    this.listFoldedSignal.set(folded);
    this.viewState.write(LIST_FOLDED_KEY, folded);
  }

  /** Folds a project's sessions away behind its header, or brings them back. */
  toggleProject(path: string): void {
    const next = { ...this.foldsSignal() };
    if (next[path] === true) {
      delete next[path];
    } else {
      next[path] = true;
    }
    this.remember(next);
  }

  /**
   * The first view of the list: `open` is the one project left unfolded — the one
   * the reader is in — and every other one waits behind its header. Called once;
   * from then on the record is the reader's own.
   */
  seedFolds(paths: readonly string[], open: string | undefined): void {
    const next: ProjectFolds = {};
    for (const path of paths) {
      if (path !== open) {
        next[path] = true;
      }
    }
    this.remember(next);
  }

  private remember(next: ProjectFolds): void {
    this.foldsSignal.set(next);
    // Writing the default empty map still counts as on record: it says the reader
    // has seen the list, so a project added later must not re-fold everything.
    this.rememberedSignal.set(true);
    this.viewState.write(FOLDS_KEY, next);
  }
}
