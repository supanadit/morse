import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  Subject,
  debounceTime,
  distinctUntilChanged,
  filter,
  from,
  map,
  merge,
  switchMap,
} from 'rxjs';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { Dialog } from '../../ui/dialog/dialog';

/** One subdirectory row, as the host reports it. */
export interface DirectoryEntry {
  name: string;
  path: string;
}

/** What `listDirectories` answers with; the host decorates it with `canOpen`. */
export interface DirectoryListing {
  path: string;
  parent?: string;
  directories: DirectoryEntry[];
  isGitRepo: boolean;
  roots: DirectoryEntry[];
  canOpen: boolean;
}

/**
 * The browser host's "New session" picker.
 *
 * VS Code has a workspace folder, so its New session already knows where the
 * agent runs. The browser host has none: it serves a machine, and the user has
 * to say which project the session belongs to.
 *
 * The question is answered in two steps. The common case is an existing project —
 * the same ones the sidebar groups sessions by — so that is the first screen, and
 * picking one starts the session at once. The folder browser (the folder the host
 * offers, its subfolders, and `ProjectPolicy`'s `canOpen`) is the second step, for
 * a project pi has never seen. A host with no known projects skips straight to it.
 * Browsing is read-only; the host still applies `ProjectPolicy` when the session
 * is actually opened.
 */
@Component({
  selector: 'morse-project-picker',
  templateUrl: './project-picker.html',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './project-picker.css',
})
export class ProjectPicker {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly tabs = inject(WorkspaceTabs);

  /** The projects screen's filter; created only while that screen is showing. */
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  /** The projects screen's list, scrolled by arrow keys. */
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  /** The folder browser's path field; created only while that screen is showing. */
  private readonly pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');

  protected readonly loading = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  /** The folder currently shown; the one a session will be created in. */
  protected readonly path = signal('');
  /** The editable text, which may differ from `path` until the user submits. */
  protected readonly draftPath = signal('');
  protected readonly parent = signal<string | undefined>(undefined);
  protected readonly directories = signal<DirectoryEntry[]>([]);
  protected readonly roots = signal<DirectoryEntry[]>([]);
  protected readonly isGitRepo = signal(false);
  protected readonly canOpen = signal(false);

  /**
   * Which half of the dialog is showing. `projects` answers the common case —
   * "a session in one of the projects I already have" — without making the user
   * navigate the filesystem to find it; `browse` is the folder browser for a
   * project pi has never seen. A host with no known projects has nothing to list,
   * so it opens straight into `browse`.
   */
  protected readonly mode = signal<'projects' | 'browse'>('projects');
  protected readonly projectQuery = signal('');
  /**
   * Which matched project row Enter would start the session in. Kept as an index
   * into `matchedProjects()`, reset whenever the query does, so the highlight and
   * the Enter target can never point at a row that is no longer on screen.
   */
  protected readonly active = signal(0);
  /** Every project pi knows, the same list the sidebar groups sessions by. */
  protected readonly projects = this.morse.projects;
  protected readonly matchedProjects = computed(() => {
    const needle = this.projectQuery().trim().toLowerCase();
    if (needle.length === 0) {
      return this.projects();
    }
    return this.projects().filter((project) =>
      `${project.name} ${project.path}`.toLowerCase().includes(needle),
    );
  });
  protected readonly hasProjects = computed(() => this.projects().length > 0);

  /**
   * Navigation (a click, a parent, a root chip) is answered at once; typing is
   * debounced. Both funnel through the same stream so a newer request cancels the
   * one still in flight and only the last thing asked for can land.
   */
  private readonly browse$ = new Subject<{ path?: string; live: boolean }>();
  private readonly typedPath$ = new Subject<string>();
  /** Bumped on every navigation, so a debounced keystroke it overtook is dropped. */
  private revision = 0;

  constructor() {
    merge(
      this.browse$,
      this.typedPath$.pipe(
        // Stamp the keystroke before debouncing: if the user navigates while it
        // waits out the debounce, the stamp no longer matches and it is dropped.
        map((value) => ({ value: value.trim(), revision: this.revision })),
        debounceTime(250),
        distinctUntilChanged((a, b) => a.value === b.value && a.revision === b.revision),
        filter(({ value, revision }) => revision === this.revision && value !== this.path()),
        map(({ value }): { path?: string; live: boolean } => ({
          path: value.length > 0 ? value : undefined,
          live: true,
        })),
      ),
    )
      .pipe(
        switchMap((request) =>
          from(
            this.morse.requestHostCommand(
              'listDirectories',
              request.path ? { path: request.path } : undefined,
            ),
          ).pipe(map((data) => ({ request, listing: data as DirectoryListing | undefined }))),
        ),
        takeUntilDestroyed(),
      )
      .subscribe(({ request, listing }) => this.apply(listing, request.live));

    // Nothing to pick from means the folder browser is the only useful screen.
    if (!this.hasProjects()) {
      this.mode.set('browse');
      this.load();
    }
    // Arrow keys move the highlight; keep the row inside the list's viewport so
    // the row Enter would pick is always one the reader can see.
    effect(() => {
      this.active();
      this.matchedProjects();
      setTimeout(() => this.revealActive(), 0);
    });

    // The dialog exists to be typed into: opening it (the sidebar button, the
    // empty panel, or the command palette) must land the caret in the field for
    // the screen it shows, not leave it behind on the trigger that opened it.
    afterNextRender(() => this.focusField());
  }

  /** Nudges the highlighted project row into the list viewport. */
  private revealActive(): void {
    if (this.mode() !== 'projects') {
      return;
    }
    const container = this.list()?.nativeElement;
    const row = container?.querySelectorAll<HTMLElement>('.project-row')[this.active()];
    if (!container || !row) {
      return;
    }
    const view = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < view.top) {
      container.scrollTop -= view.top - rect.top;
    } else if (rect.bottom > view.bottom) {
      container.scrollTop += rect.bottom - view.bottom;
    }
  }

  /** Puts the caret in the field the current screen is built around. */
  private focusField(): void {
    if (this.mode() === 'projects') {
      this.search()?.nativeElement.focus();
      return;
    }
    this.pathInput()?.nativeElement.focus();
  }

  /** `path` undefined means "whatever the host considers the starting folder". */
  protected go(path?: string): void {
    const target = path?.trim();
    this.load(target && target.length > 0 ? target : undefined);
  }

  protected onPathInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draftPath.set(value);
    // A folder is not "chosen" until the host has read the typed path; otherwise a
    // fast click could open the folder that was on screen a moment ago.
    if (value.trim() !== this.path()) {
      this.canOpen.set(false);
    }
    this.typedPath$.next(value);
  }

  protected close(): void {
    this.shell.closeProjectPicker();
  }

  /** An existing project: a session there needs no filesystem detour. */
  protected chooseProject(path: string): void {
    this.confirmPath(path);
  }

  /** "Choose a folder…": the other half of the question, for a new project. */
  protected browseForFolder(): void {
    this.mode.set('browse');
    if (this.path().length === 0) {
      this.load();
    }
    // The screen changed: hand the caret to the field it shows once it renders.
    setTimeout(() => this.focusField(), 0);
  }

  protected backToProjects(): void {
    this.mode.set('projects');
    this.projectQuery.set('');
    this.active.set(0);
    setTimeout(() => this.focusField(), 0);
  }

  protected onProjectQuery(event: Event): void {
    this.projectQuery.set((event.target as HTMLInputElement).value);
    this.active.set(0);
  }

  /**
   * The caret stays in the search field; the arrow keys move the highlight and
   * Enter opens the highlighted project, so finding a project by typing does not
   * force a detour through the mouse.
   */
  protected onSearchKeydown(event: KeyboardEvent): void {
    const rows = this.matchedProjects();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((index) => Math.min(index + 1, Math.max(0, rows.length - 1)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => Math.max(0, index - 1));
        return;
      case 'Enter': {
        const chosen = rows[this.active()] ?? rows[0];
        if (!chosen) {
          return;
        }
        event.preventDefault();
        this.chooseProject(chosen.path);
        return;
      }
      default:
        return;
    }
  }

  /** Creates the session as a draft in the chosen folder. */
  protected confirm(): void {
    if (this.path().length === 0 || !this.canOpen()) {
      return;
    }
    this.confirmPath(this.path());
  }

  private confirmPath(path: string): void {
    if (path.length === 0) {
      return;
    }
    this.tabs.startDraft(path);
    this.shell.closeNavigation();
    this.close();
  }

  /**
   * The user asked to leave — Escape, or a click on the backdrop. Both step back
   * through the dialog before they close it: a reader who opened the browser to look
   * around should not lose the project list.
   */
  protected leave(): void {
    if (this.mode() === 'browse' && this.hasProjects()) {
      this.backToProjects();
      return;
    }
    this.close();
  }

  private load(path?: string): void {
    this.loading.set(true);
    this.error.set(undefined);
    this.revision += 1;
    this.browse$.next({ path: path?.trim() || undefined, live: false });
  }

  /**
   * Applies a listing. A live (typed) response never rewrites `draftPath`, so the
   * caret stays where the user left it; navigation adopts the resolved folder.
   */
  private apply(listing: DirectoryListing | undefined, live: boolean): void {
    this.loading.set(false);
    if (!listing || typeof listing.path !== 'string') {
      // A path the host could not read: keep what the user typed so they can fix
      // it, and say so instead of silently bouncing to the old folder.
      this.error.set('That folder could not be read.');
      if (live) {
        // The listing on screen no longer belongs to the typed path, and neither
        // does the folder a session would start in.
        this.directories.set([]);
        this.parent.set(undefined);
        this.isGitRepo.set(false);
        this.canOpen.set(false);
      }
      return;
    }
    this.error.set(undefined);
    this.path.set(listing.path);
    if (!live) {
      this.draftPath.set(listing.path);
    }
    this.parent.set(listing.parent);
    this.directories.set(listing.directories ?? []);
    this.roots.set(listing.roots ?? []);
    this.isGitRepo.set(listing.isGitRepo === true);
    this.canOpen.set(listing.canOpen === true);
  }
}
