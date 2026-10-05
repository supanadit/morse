import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject } from '@angular/core';
import { MorseService } from '../../core/morse.service';
import { DisplayPrefs } from '../../core/display-prefs';
import { ShellState } from '../../core/shell-state';
import { ShortcutService } from '../../core/shortcuts';
import { WorkspaceTabs } from '../../core/workspace-tabs';

@Component({
  selector: 'morse-chat-header',
  templateUrl: './chat-header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /*
       * A calm toolbar, not a card. It shares the chat background (the old
       * --morse-panel bar read as a stray strip above the transcript) and only a
       * hairline separates it from the conversation.
       */
      :host {
        display: block;
        flex: none;
        background: var(--morse-bg);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 6px;
        /*
         * Shares --morse-head-height with the sidebar: the two headers sit side
         * by side, so a hairline that lands at two different heights reads as a
         * broken layout, not as a design choice.
         *
         * The hairline belongs to *this* element, not to :host: with
         * box-sizing: border-box a 1px border on the host would be added on top
         * of the shared height and land 1px below the sidebar's.
         */
        min-height: var(--morse-head-height);
        padding: 0 8px;
        border-bottom: 1px solid var(--morse-border);
      }
      /* Borderless icon buttons, the way an editor toolbar behaves. */
      .icon {
        flex: none;
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      .icon:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .icon:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .icon .glyph {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .menu {
        display: none;
      }
      /*
       * Two ways to hide the navigation, one visible at a time: the drawer toggle
       * below 760px (the navigation overlays the chat there) and the fold toggle
       * above it (the navigation is a column, and folding it widens the chat).
       * CSS decides, so the breakpoint stays in one place.
       */
      .collapse {
        display: none;
      }
      @media (max-width: 759px) {
        .menu {
          display: inline-flex;
        }
      }
      @media (min-width: 760px) {
        .collapse {
          display: inline-flex;
        }
      }
      .titles {
        flex: 1;
        min-width: 0;
        line-height: 1.3;
      }
      .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
        font-weight: 600;
      }
      .meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--morse-fg-muted);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: none;
      }
      /*
       * The lifecycle lives in a dot instead of a coloured pill: green and quiet
       * while healthy, amber and pulsing while starting, red when it failed.
       */
      .status {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 6px;
        font-size: 11px;
        color: var(--morse-fg-muted);
        white-space: nowrap;
      }
      .dot {
        flex: none;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--morse-fg-muted);
      }
      .status.online .dot {
        background: var(--morse-success);
      }
      .status.busy .dot {
        background: var(--morse-warn);
        animation: status-pulse 1.1s ease-in-out infinite;
      }
      .status.failed {
        color: var(--morse-error);
      }
      .status.failed .dot {
        background: var(--morse-error);
      }
      @keyframes status-pulse {
        50% {
          opacity: 0.35;
        }
      }
    `,
  ],
})
export class ChatHeader {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly display = inject(DisplayPrefs);
  private readonly shortcuts = inject(ShortcutService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly state = this.morse.state;
  protected readonly connection = this.morse.connection;
  protected readonly connectionDetail = this.morse.connectionDetail;
  protected readonly workspace = this.morse.workspace;
  protected readonly navigationOpen = this.shell.navigationOpen;
  /** Wide layouts: the sidebar is folded away and this button brings it back. */
  protected readonly collapsed = this.shell.navigationCollapsed;
  /** The reader's chosen tool-call density, toggled from the toolbar. */
  protected readonly compactTools = computed(() => this.display.toolDisplay() === 'compact');
  /** The git panel's button only exists where the host can answer `gitLog`. */
  protected readonly gitEnabled = computed(() => this.morse.capabilities()?.gitPanel === true);
  protected readonly gitOpen = this.shell.gitPanelOpen;

  constructor() {
    // The header owns the git toggle's button, so it owns the key too: an
    // unavailable row (a host without `gitPanel`) is shown as unavailable rather
    // than promised.
    const unbind = this.shortcuts.bind(
      'view.git',
      () => this.shell.toggleGitPanel(),
      () => this.gitEnabled(),
    );
    this.destroyRef.onDestroy(unbind);
  }

  /** The happy path lives in the dot: no banner needed while it is healthy. */
  protected readonly status = computed(() => {
    const connection = this.connection();
    if (connection !== 'ready') {
      return connection;
    }
    if (this.state().agentStarting) {
      return 'starting';
    }
    // The lazy no-session state is healthy, not a failure: the host spawns the
    // agent on the first prompt, so the dot stays ready and the hint lives in
    // the empty-state hero instead.
    if (!this.state().agentReady && this.state().agentError === undefined) {
      return 'ready';
    }
    return this.state().agentReady ? 'ready' : 'error';
  });

  protected readonly statusLabel = computed(() => {
    switch (this.status()) {
      case 'ready':
        return 'Ready';
      case 'starting':
        return 'Starting…';
      case 'connecting':
        return 'Connecting…';
      case 'closed':
        return 'Disconnected';
      case 'error':
        return 'Error';
      default:
        return this.status();
    }
  });

  protected readonly statusTitle = computed(() => {
    const detail = this.connectionDetail();
    return detail ? `${this.statusLabel()} · ${detail}` : this.statusLabel();
  });

  /**
   * True when no session is in front on a tabbed host — the empty placeholder.
   * The host's workspace is still whatever it last was, so naming it here read as
   * "this empty panel belongs to the previous project".
   */
  private readonly noSessionInFront = this.tabs.noSessionInFront;

  protected readonly title = computed(() => {
    if (this.noSessionInFront()) {
      return 'Morse';
    }
    return this.state().sessionTitle || this.workspace().name || 'Morse';
  });

  /**
   * One muted line under the title. The workspace name is only repeated when it
   * is not already the title — a fresh session used to read "morse" twice — and
   * not at all when no session is in front.
   */
  protected readonly meta = computed(() => {
    const parts: string[] = [];
    const workspaceName = this.workspace().name;
    if (!this.noSessionInFront() && workspaceName && workspaceName !== this.title()) {
      parts.push(workspaceName);
    }
    const model = this.state().model;
    if (model) {
      parts.push(model.name);
    }
    return parts.join(' · ');
  });

  protected toggleNavigation(): void {
    this.shell.toggleNavigation();
  }

  /** The wide-layout twin of `toggleNavigation`: fold the column, not the drawer. */
  protected toggleSidebar(): void {
    this.shell.toggleNavigationCollapsed();
  }

  protected compact(): void {
    // Never straight to the agent: the dialog owns the question (see ShellState).
    this.shell.requestCompact();
  }

  /** Flips between the detailed timeline and the compact summary, and remembers it. */
  protected toggleToolDisplay(): void {
    this.display.toggleToolDisplay();
  }

  /** Shows or hides the browser host's git panel. */
  protected toggleGit(): void {
    this.shell.toggleGitPanel();
  }
}
