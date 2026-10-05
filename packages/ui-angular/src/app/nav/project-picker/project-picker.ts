import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
  signal,
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
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';
import { WorkspaceTabs } from '../../core/workspace-tabs';

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
 * The browser host's "New session" folder browser.
 *
 * VS Code has a workspace folder, so its New session already knows where the
 * agent runs. The browser host has none: it serves a machine, and the user has
 * to say which project the session belongs to. This is that question, rendered
 * as an overlay (capabilities.directoryPicker). Browsing is read-only; the host
 * still applies `ProjectPolicy` when the session is actually opened.
 */
@Component({
  selector: 'morse-project-picker',
  templateUrl: './project-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgb(0 0 0 / 45%);
      }
      .modal-card {
        display: flex;
        flex-direction: column;
        width: min(560px, 100%);
        max-height: min(640px, 90vh);
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        overflow: hidden;
      }
      .modal-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      .modal-head strong {
        flex: 1;
        font-size: 13px;
      }
      .modal-head .close {
        padding: 2px 8px;
        border: 0;
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .modal-head .close:hover {
        color: var(--morse-fg);
      }
      .modal-sub {
        margin: 0;
        padding: 8px 14px 0;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
      }
      .path-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 14px;
      }
      .path-row input {
        flex: 1;
        min-width: 0;
        font-family: var(--morse-font-mono);
        font-size: 12px;
      }
      .path-row button {
        flex: none;
        padding: 4px 10px;
      }
      .roots {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 14px 8px;
      }
      .chip {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 2px 9px;
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        cursor: pointer;
      }
      .chip:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .listing {
        flex: 1;
        min-height: 160px;
        overflow-y: auto;
        border-top: 1px solid var(--morse-border);
        padding: 4px 6px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        text-align: left;
        cursor: pointer;
      }
      .row:hover,
      .row:focus-visible {
        background: var(--morse-hover);
      }
      .row .folder {
        flex: none;
        width: 14px;
        color: var(--morse-fg-muted);
        text-align: center;
      }
      .row .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row .mark {
        flex: none;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--morse-badge-bg);
        color: var(--morse-badge-fg);
        font-size: 10px;
      }
      .state {
        margin: 8px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
      .state.error {
        color: var(--morse-error);
      }
      .modal-foot {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-top: 1px solid var(--morse-border);
      }
      .selected {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
        text-align: left;
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 11px;
      }
      .selected em {
        color: var(--morse-warn, var(--morse-error));
        font-style: normal;
      }
      .actions {
        display: flex;
        flex: none;
        gap: 6px;
      }
    `,
  ],
})
export class ProjectPicker {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly tabs = inject(WorkspaceTabs);

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

    this.load();
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

  /** Creates the session as a draft in the chosen folder. */
  protected confirm(): void {
    const path = this.path();
    if (path.length === 0 || !this.canOpen()) {
      return;
    }
    this.tabs.startDraft(path);
    this.shell.closeNavigation();
    this.close();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
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
