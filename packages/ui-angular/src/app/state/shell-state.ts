import { Injectable, computed, inject, signal } from '@angular/core';
import { LayoutState } from './layout-state';
import { OverlayStack } from './overlay-stack';

/** Whether the git panel takes over the centre of the shell (the browser host). */
const GIT_EXPANDED_KEY = 'morse.git.expanded';
/** The git panel's Changes section: whether it is folded. */
const GIT_CHANGES_COLLAPSED_KEY = 'morse.git.changesCollapsed';
const GIT_HISTORY_COLLAPSED_KEY = 'morse.git.historyCollapsed';
/** Which panel holds the shell's right column. */
const RIGHT_PANE_KEY = 'morse.right.pane';

/**
 * The panels that share the shell's right column — the git panel and the search
 * panel. Only one is in front at a time: the column is one region with one
 * width and one stored open flag, so the two take turns rather than stacking.
 */
export type RightPane = 'git' | 'search';

function readRightPane(): RightPane {
  try {
    return globalThis.localStorage?.getItem(RIGHT_PANE_KEY) === 'search' ? 'search' : 'git';
  } catch {
    return 'git';
  }
}

function storeRightPane(pane: RightPane): void {
  try {
    globalThis.localStorage?.setItem(RIGHT_PANE_KEY, pane);
  } catch {
    // As below: storage is a nicety, not a requirement.
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

/**
 * Shell state that several components need (narrow layouts hide the navigation
 * behind a toggle, wide layouts keep it open). Kept out of `MorseService`, which
 * only knows about the wire protocol.
 */
@Injectable({ providedIn: 'root' })
export class ShellState {
  /**
   * The dialogs that are open, in the order they opened. The overlay flags below say
   * *which* dialog, which their own callers need; this says whether any is up at all,
   * which is what `modalOpen` answers.
   */
  private readonly stack = inject(OverlayStack);
  /**
   * Where the columns are, how wide, and whether they are shown at all. Those facts live
   * in one place rather than here, so the layout has a home to grow in
   * (`state/layout-state.ts`).
   */
  private readonly layout = inject(LayoutState);

  private readonly navigationVisible = signal(false);
  readonly navigationOpen = this.navigationVisible.asReadonly();

  /** Expanded: the panel leaves the sidebar and takes the centre of the shell. */
  private readonly gitExpanded = signal(readGitExpanded());
  readonly gitPanelExpanded = this.gitExpanded.asReadonly();
  /** The open repository's Changes section: whether it is folded. */
  private readonly changesCollapsedSignal = signal(readFlag(GIT_CHANGES_COLLAPSED_KEY));
  readonly gitChangesCollapsed = this.changesCollapsedSignal.asReadonly();
  /** The open repository's History section: whether it is folded. */
  private readonly historyCollapsedSignal = signal(readFlag(GIT_HISTORY_COLLAPSED_KEY));
  readonly gitHistoryCollapsed = this.historyCollapsedSignal.asReadonly();

  /**
   * Which panel the right column holds. The column's open flag and width are
   * the git panel's stored keys (`morse.git.open`, `morse.git.width`) — a
   * stored layout belongs to the reader and is not renamed — so this only says
   * which of the two faces is in front when the column is open.
   */
  private readonly rightPaneSignal = signal<RightPane>(readRightPane());
  readonly rightPane = this.rightPaneSignal.asReadonly();

  setRightPane(pane: RightPane): void {
    storeRightPane(pane);
    this.rightPaneSignal.set(pane);
  }

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
   * The command palette. Shell state like the help: the shortcut opens it from
   * anywhere, it renders over the whole app from one place, and `modalOpen` has
   * to know it owns the screen.
   */
  private readonly palette = signal(false);
  readonly paletteOpen = this.palette.asReadonly();

  /**
   * The project filter. The list narrowed to one project is `SessionNav`'s to
   * render, but *which* project and whether the panel is up live here: two
   * places open the panel (the sidebar button and the shortcut), the command
   * palette narrows the list too, and `modalOpen` has to be honest about what is
   * on screen.
   */
  private readonly projectFilter = signal(false);
  readonly projectFilterOpen = this.projectFilter.asReadonly();
  private readonly projectFocus = signal('');
  /** The project the sidebar is narrowed to; `''` shows every one of them. */
  readonly projectFilterPath = this.projectFocus.asReadonly();

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
  /** The conversation the compact question was asked about, pinned on confirm. */
  readonly compactSessionKey = computed(() => this.compactPrompt()?.sessionKey);

  /**
   * The stop gate. Aborting a run throws away the turn in flight — and the key that
   * does it sits next to the ones used to steer, so a stray press used to end the
   * run outright. It always asks first, the same way compaction does. Steering and
   * follow-ups are not gated: they queue, and a queued message can be cancelled.
   */
  private readonly stopPrompt = signal(false);
  readonly stopConfirmOpen = this.stopPrompt.asReadonly();

  /**
   * The MCP manager. Shell state like About: the header's indicator opens it,
   * it renders over the whole app from one place, and `modalOpen` has to know it
   * owns the screen.
   */
  private readonly mcp = signal(false);
  readonly mcpOpen = this.mcp.asReadonly();

  /**
   * True while a dialog owns the screen. Overlay shortcuts stand down on this:
   * opening a picker behind a modal reads as a bug, not as a feature.
   *
   * Read from the overlay stack rather than from the flags above, one per dialog:
   * that list had to be kept by hand, and the dialog that was forgotten let a shortcut
   * fire behind it. `ui/dialog` registers while it is up and releases on destroy, so
   * this is true exactly while one is.
   */
  readonly modalOpen = computed(() => this.stack.depth() > 0);

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
  unfoldNavigation(): void {
    this.layout.setVisible('left', true);
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

  openPalette(): void {
    this.palette.set(true);
  }

  closePalette(): void {
    this.palette.set(false);
  }

  /** The palette's own key toggles it closed as well as open. */
  togglePalette(): void {
    this.palette.update((open) => !open);
  }

  /** Narrows the sidebar to one project; `''` is every project. */
  setProjectFilter(path: string): void {
    this.projectFocus.set(path);
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

  /** Opens the MCP manager (the header's indicator owns the click). */
  openMcp(): void {
    this.mcp.set(true);
  }

  closeMcp(): void {
    this.mcp.set(false);
  }

  /**
   * Asks before compacting; the caller runs the action on confirmation.
   * `sessionKey` is the conversation the question is about, captured when the
   * dialog opens so confirming cannot compact a session the user switched to in
   * the meantime (or none that is in front at all).
   */
  requestCompact(instructions?: string, sessionKey?: string): void {
    this.compactPrompt.set({ ...(instructions ? { instructions } : {}), sessionKey });
  }

  closeCompactPrompt(): void {
    this.compactPrompt.set(undefined);
  }

  /** Asks before aborting the run; the caller runs the action on confirmation. */
  requestStop(): void {
    this.stopPrompt.set(true);
  }

  closeStopPrompt(): void {
    this.stopPrompt.set(false);
  }
}

/** The pending compaction: confirmed, then run with whatever it carried. */
interface CompactPrompt {
  /** `/compact keep the decisions` — the words after the command, if any. */
  instructions?: string;
  /** The session it was asked about, pinned on confirm. */
  sessionKey?: string;
}
