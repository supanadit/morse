import { Injectable, computed, signal } from '@angular/core';

/**
 * Where the wide-layout preference is remembered. A webview or a browser with
 * storage disabled simply forgets it — the toggle still works for the session.
 */
const NAV_COLLAPSED_KEY = 'morse.navigation.collapsed';
/** The git panel's open state, so it comes back after a reload. */
const GIT_PANEL_KEY = 'morse.git.open';
/** Whether the git panel takes over the centre of the shell (the browser host). */
const GIT_EXPANDED_KEY = 'morse.git.expanded';
/** The git panel's column width, once its left edge has been dragged. */
const GIT_WIDTH_KEY = 'morse.git.width';
const GIT_WIDTH_MIN = 220;
const GIT_WIDTH_MAX = 1600;
/** The git panel's Changes section: its dragged height, and its folded state. */
const GIT_CHANGES_HEIGHT_KEY = 'morse.git.changesHeight';
const GIT_CHANGES_COLLAPSED_KEY = 'morse.git.changesCollapsed';
const GIT_HISTORY_COLLAPSED_KEY = 'morse.git.historyCollapsed';
/** The Staged / Unstaged groups fold on their own, like VS Code's Source Control. */
const GIT_STAGED_COLLAPSED_KEY = 'morse.git.stagedCollapsed';
const GIT_UNSTAGED_COLLAPSED_KEY = 'morse.git.unstagedCollapsed';
const GIT_CHANGES_MIN_HEIGHT = 48;
const GIT_CHANGES_MAX_HEIGHT = 1200;
/** The Explorer pane's height, so a resize survives a reload. */
const EXPLORER_HEIGHT_KEY = 'morse.explorer.height';
const EXPLORER_MIN_HEIGHT = 140;
const EXPLORER_MAX_HEIGHT = 720;

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

function readGitPanelOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(GIT_PANEL_KEY) === '1';
  } catch {
    return false;
  }
}

function storeGitPanelOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(GIT_PANEL_KEY, open ? '1' : '0');
  } catch {
    // As above: the signal is the truth for this session either way.
  }
}

function readGitExpanded(): boolean {
  try {
    return globalThis.localStorage?.getItem(GIT_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeGitExpanded(expanded: boolean): void {
  try {
    globalThis.localStorage?.setItem(GIT_EXPANDED_KEY, expanded ? '1' : '0');
  } catch {
    // As above.
  }
}

function clampChangesHeight(px: number): number {
  return Math.round(Math.min(GIT_CHANGES_MAX_HEIGHT, Math.max(GIT_CHANGES_MIN_HEIGHT, px)));
}

function clampGitWidth(px: number): number {
  return Math.round(Math.min(GIT_WIDTH_MAX, Math.max(GIT_WIDTH_MIN, px)));
}

function readGitWidth(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(GIT_WIDTH_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clampGitWidth(value) : undefined;
  } catch {
    return undefined;
  }
}

function storeGitWidth(px: number): void {
  try {
    globalThis.localStorage?.setItem(GIT_WIDTH_KEY, String(px));
  } catch {
    // As above: the signal is the truth for this session either way.
  }
}

function readChangesHeight(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(GIT_CHANGES_HEIGHT_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clampChangesHeight(value) : undefined;
  } catch {
    return undefined;
  }
}

function storeChangesHeight(px: number): void {
  try {
    globalThis.localStorage?.setItem(GIT_CHANGES_HEIGHT_KEY, String(px));
  } catch {
    // As above.
  }
}

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function storeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    // As above.
  }
}

function clampExplorerHeight(px: number): number {
  return Math.round(Math.min(EXPLORER_MAX_HEIGHT, Math.max(EXPLORER_MIN_HEIGHT, px)));
}

function readExplorerHeight(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(EXPLORER_HEIGHT_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clampExplorerHeight(value) : undefined;
  } catch {
    return undefined;
  }
}

function storeExplorerHeight(px: number): void {
  try {
    globalThis.localStorage?.setItem(EXPLORER_HEIGHT_KEY, String(px));
  } catch {
    // As above: the signal is the truth for this session either way.
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
   * The browser host's git panel (right column): the active project's history
   * and graph. A layout preference like the navigation fold — remembered across
   * reloads — and only ever rendered where the host advertises `gitPanel`.
   */
  private readonly gitPanel = signal(readGitPanelOpen());
  readonly gitPanelOpen = this.gitPanel.asReadonly();
  /** Expanded: the panel leaves the sidebar and takes the centre of the shell. */
  private readonly gitExpanded = signal(readGitExpanded());
  readonly gitPanelExpanded = this.gitExpanded.asReadonly();
  /**
   * The git panel's column width (px). `undefined` keeps the default from
   * `styles.css`; once the reader drags the panel's left edge toward the
   * conversation, the chosen width is remembered like the Explorer's height.
   */
  private readonly gitWidthSignal = signal<number | undefined>(readGitWidth());
  readonly gitPanelWidth = this.gitWidthSignal.asReadonly();
  /** The git panel's Changes section: its dragged height (px) and folded state. */
  private readonly changesHeightSignal = signal<number | undefined>(readChangesHeight());
  readonly gitChangesHeight = this.changesHeightSignal.asReadonly();
  private readonly changesCollapsedSignal = signal(readFlag(GIT_CHANGES_COLLAPSED_KEY));
  readonly gitChangesCollapsed = this.changesCollapsedSignal.asReadonly();
  private readonly historyCollapsedSignal = signal(readFlag(GIT_HISTORY_COLLAPSED_KEY));
  readonly gitHistoryCollapsed = this.historyCollapsedSignal.asReadonly();
  /** The two change groups, each folded independently. */
  private readonly stagedCollapsedSignal = signal(readFlag(GIT_STAGED_COLLAPSED_KEY));
  readonly gitStagedCollapsed = this.stagedCollapsedSignal.asReadonly();
  private readonly unstagedCollapsedSignal = signal(readFlag(GIT_UNSTAGED_COLLAPSED_KEY));
  readonly gitUnstagedCollapsed = this.unstagedCollapsedSignal.asReadonly();
  /**
   * The browser host's Explorer pane height (px). `undefined` means the default
   * (`max-height` in CSS); once the user drags its top edge, the chosen height is
   * remembered like the navigation fold.
   */
  private readonly explorer = signal<number | undefined>(readExplorerHeight());
  readonly explorerHeight = this.explorer.asReadonly();

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
   * The prompt-template form. The composer owns the request (it needs the
   * attachments and the prompt action), but the flag lives here like the other
   * overlays so `modalOpen` can tell the shortcuts a dialog is up.
   */
  private readonly promptTemplate = signal(false);
  readonly promptTemplateOpen = this.promptTemplate.asReadonly();

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
      this.promptTemplate() ||
      this.compactPrompt() !== undefined,
  );

  toggleNavigation(): void {
    this.navigationVisible.update((open) => !open);
  }

  /** Used by the sidebar's shortcuts: a closed drawer is off canvas, so nothing inside it can be seen. */
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
   * Used by the sidebar's shortcuts: a folded column is `visibility: hidden`,
   * and a field nobody can see cannot take focus either.
   */
  unfoldNavigation(): void {
    this.setCollapsed(false);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed);
    storeNavCollapsed(collapsed);
  }

  /** Shows or hides the git panel; the panel itself refreshes while it is open. */
  toggleGitPanel(): void {
    this.setGitPanel(!this.gitPanel());
  }

  closeGitPanel(): void {
    this.setGitPanel(false);
  }

  private setGitPanel(open: boolean): void {
    this.gitPanel.set(open);
    storeGitPanelOpen(open);
  }

  /** Wide graph mode: the panel spans the conversation area instead of the sidebar. */
  toggleGitPanelExpanded(): void {
    this.setGitExpanded(!this.gitExpanded());
  }

  private setGitExpanded(expanded: boolean): void {
    this.gitExpanded.set(expanded);
    storeGitExpanded(expanded);
  }

  /** Folds the Changes section down to its header, or brings it back. */
  toggleGitChanges(): void {
    this.changesCollapsedSignal.update((collapsed) => !collapsed);
    storeFlag(GIT_CHANGES_COLLAPSED_KEY, this.changesCollapsedSignal());
  }

  /** Folds the History section down to its header, or brings it back. */
  toggleGitHistory(): void {
    this.historyCollapsedSignal.update((collapsed) => !collapsed);
    storeFlag(GIT_HISTORY_COLLAPSED_KEY, this.historyCollapsedSignal());
  }

  /** Folds the Staged group down to its header, or brings it back. */
  toggleGitStaged(): void {
    this.stagedCollapsedSignal.update((collapsed) => !collapsed);
    storeFlag(GIT_STAGED_COLLAPSED_KEY, this.stagedCollapsedSignal());
  }

  /** Folds the Unstaged group down to its header, or brings it back. */
  toggleGitUnstaged(): void {
    this.unstagedCollapsedSignal.update((collapsed) => !collapsed);
    storeFlag(GIT_UNSTAGED_COLLAPSED_KEY, this.unstagedCollapsedSignal());
  }

  /** Drag-to-resize the divider between Changes and History; clamped to a usable range. */
  setGitChangesHeight(px: number, persist = true): void {
    const next = clampChangesHeight(px);
    this.changesHeightSignal.set(next);
    if (persist) {
      storeChangesHeight(next);
    }
  }

  /** Drag-to-resize the git panel from its left edge; clamped to a usable range. */
  setGitPanelWidth(px: number, persist = true): void {
    const next = clampGitWidth(px);
    this.gitWidthSignal.set(next);
    if (persist) {
      storeGitWidth(next);
    }
  }

  /** Double-clicking the edge restores the default column width from `styles.css`. */
  resetGitPanelWidth(): void {
    this.gitWidthSignal.set(undefined);
    try {
      globalThis.localStorage?.removeItem(GIT_WIDTH_KEY);
    } catch {
      // As above: the signal is the truth for this session either way.
    }
  }

  /** Drag-to-resize from the Explorer's top edge; clamped to a usable range. */
  setExplorerHeight(px: number): void {
    const next = clampExplorerHeight(px);
    this.explorer.set(next);
    storeExplorerHeight(next);
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

  /** Set by the composer when its prompt-template form opens and closes. */
  setPromptTemplateOpen(open: boolean): void {
    this.promptTemplate.set(open);
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
