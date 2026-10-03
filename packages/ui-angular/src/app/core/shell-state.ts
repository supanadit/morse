import { Injectable, computed, signal } from '@angular/core';

/**
 * Where the wide-layout preference is remembered. A webview or a browser with
 * storage disabled simply forgets it — the toggle still works for the session.
 */
const NAV_COLLAPSED_KEY = 'morse.navigation.collapsed';

function readNavCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeNavCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage is a nicety, not a requirement: the signal still holds the state.
  }
}

/**
 * Shell state that several components need (narrow layouts hide the navigation
 * behind a toggle, wide layouts keep it open). Kept out of `MorseService`, which
 * only knows about the wire protocol.
 */
@Injectable({ providedIn: 'root' })
export class ShellState {
  private readonly navigationVisible = signal(false);
  readonly navigationOpen = this.navigationVisible.asReadonly();

  /**
   * Wide layouts: the navigation column folded away, so the conversation gets the
   * whole width. The narrow drawer above is a different thing — a transient
   * overlay, not a layout preference — so the two keep separate flags, and only
   * this one is remembered across reloads.
   */
  private readonly collapsed = signal(readNavCollapsed());
  readonly navigationCollapsed = this.collapsed.asReadonly();

  /**
   * The "New session" folder browser (browser host only). It is shell state
   * because two buttons open it — the sidebar's and the header's — while it
   * overlays the whole app from one place (see `app.html`).
   */
  private readonly projectPicker = signal(false);
  readonly projectPickerOpen = this.projectPicker.asReadonly();

  /**
   * The About/credits dialog. Shell state for the same reason as the picker:
   * several places open it (the sidebar footer, `/about`) and it overlays the
   * whole app from one place (see `app.html`).
   */
  private readonly about = signal(false);
  readonly aboutOpen = this.about.asReadonly();

  /**
   * The keyboard help. Shell state like About: the sidebar footer and `?` both
   * open it, and it renders over the whole app from one place.
   */
  private readonly shortcuts = signal(false);
  readonly shortcutsOpen = this.shortcuts.asReadonly();

  /**
   * The project filter. The list narrowed to one project is `SessionNav`'s to
   * keep, but the flag lives here: two places open it (the sidebar button and
   * the shortcut), and `modalOpen` has to be honest about what is on screen.
   */
  private readonly projectFilter = signal(false);
  readonly projectFilterOpen = this.projectFilter.asReadonly();

  /**
   * The compaction gate. Compaction spends a model call and replaces what the agent
   * remembers, so it always asks first: two places request it (the header button and
   * `/compact`), and one stray click used to be enough to start it.
   */
  private readonly compactPrompt = signal<CompactPrompt | undefined>(undefined);
  readonly compactConfirmOpen = computed(() => this.compactPrompt() !== undefined);
  /** Whatever the user typed after `/compact`, handed to pi on confirmation. */
  readonly compactInstructions = computed(() => this.compactPrompt()?.instructions);

  /**
   * True while a dialog owns the screen. Overlay shortcuts stand down on this:
   * opening a picker behind a modal reads as a bug, not as a feature.
   */
  readonly modalOpen = computed(
    () =>
      this.about() ||
      this.shortcuts() ||
      this.projectPicker() ||
      this.projectFilter() ||
      this.compactPrompt() !== undefined,
  );

  toggleNavigation(): void {
    this.navigationVisible.update((open) => !open);
  }

  /** Used by the focus-search shortcut: a hidden drawer cannot take focus. */
  openNavigation(): void {
    this.navigationVisible.set(true);
  }

  closeNavigation(): void {
    this.navigationVisible.set(false);
  }

  /** Folds the navigation column away (wide layouts) or brings it back. */
  toggleNavigationCollapsed(): void {
    this.setCollapsed(!this.collapsed());
  }

  /**
   * Used by the focus-search shortcut: a folded column is `visibility: hidden`,
   * and a field nobody can see cannot take focus either.
   */
  unfoldNavigation(): void {
    this.setCollapsed(false);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed);
    storeNavCollapsed(collapsed);
  }

  openAbout(): void {
    this.about.set(true);
  }

  closeAbout(): void {
    this.about.set(false);
  }

  openShortcuts(): void {
    this.shortcuts.set(true);
  }

  closeShortcuts(): void {
    this.shortcuts.set(false);
  }

  /** `?` means the same key opens and closes the list, so it is a toggle. */
  toggleShortcuts(): void {
    this.shortcuts.update((open) => !open);
  }

  openProjectFilter(): void {
    this.projectFilter.set(true);
  }

  closeProjectFilter(): void {
    this.projectFilter.set(false);
  }

  openProjectPicker(): void {
    this.projectPicker.set(true);
  }

  closeProjectPicker(): void {
    this.projectPicker.set(false);
  }

  /** Asks before compacting; the caller runs the action on confirmation. */
  requestCompact(instructions?: string): void {
    this.compactPrompt.set(instructions ? { instructions } : {});
  }

  closeCompactPrompt(): void {
    this.compactPrompt.set(undefined);
  }
}

/** The pending compaction: confirmed, then run with whatever it carried. */
interface CompactPrompt {
  /** `/compact keep the decisions` — the words after the command, if any. */
  instructions?: string;
}
