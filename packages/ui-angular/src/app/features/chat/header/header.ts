import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input } from '@angular/core';
import { MorseService } from '../../../host/morse.service';
import { McpState } from '../../../state/mcp-state';
import { DisplayPrefs } from '../../../state/display-prefs';
import { ShellState } from '../../../state/shell-state';
import { ShortcutService } from '../../../services/shortcut.service';
import { WorkspaceTabs } from '../../../state/workspace-tabs';

@Component({
  selector: 'morse-chat-header',
  templateUrl: './header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './header.css',
})
export class ChatHeader {
  private readonly morse = inject(MorseService);
  private readonly mcp = inject(McpState);
  private readonly shell = inject(ShellState);
  private readonly display = inject(DisplayPrefs);
  private readonly shortcuts = inject(ShortcutService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly state = this.morse.state;
  /**
   * This header belongs to an embedded surface (a VS Code session tab), where
   * there is no Morse sidebar to fold or reveal. The two navigation buttons are
   * hidden rather than left inert — they would toggle a preference shared with
   * the panel and change nothing here.
   */
  readonly embedded = input(false);
  protected readonly connection = this.morse.connection;
  protected readonly connectionDetail = this.morse.connectionDetail;
  protected readonly workspace = this.morse.workspace;
  protected readonly navigationOpen = this.shell.navigationOpen;
  /** Wide layouts: the sidebar is folded away and this button brings it back. */
  protected readonly collapsed = this.shell.navigationCollapsed;
  /** The reader's chosen tool-call density, toggled from the toolbar. */
  protected readonly compactTools = computed(() => this.display.toolDisplay() === 'compact');
  /** The git panel's button only exists where the host can answer `gitLog`,
   * and only when a session is in front — with none there is no project. */
  protected readonly gitEnabled = computed(
    () => this.morse.capabilities()?.gitPanel === true && !this.tabs.noSessionInFront(),
  );
  protected readonly gitOpen = this.shell.gitPanelOpen;
  /**
   * The MCP indicator exists where the host can run the `pi` CLI. It is usable
   * without a session too — the panel is then global-only (the user's own
   * `mcp.json`), so this is not gated on a session being in front.
   */
  protected readonly mcpEnabled = this.mcp.enabled;
  protected readonly mcpOverall = computed(() => this.mcp.overall(this.mcp.cwd()));
  protected readonly mcpTitle = computed(() => {
    const label = this.mcp.label(this.mcp.cwd());
    return this.mcpEnabled() ? `${label} — click to manage` : label;
  });

  constructor() {
    // The header owns the git toggle's button, so it owns the key too: an
    // unavailable row (a host without `gitPanel`) is shown as unavailable rather
    // than promised.
    const unbind = this.shortcuts.bind(
      'view.git',
      () => this.shell.toggleGitPanel(),
      () => this.gitEnabled(),
    );
    const unbindMcp = this.shortcuts.bind(
      'view.mcp',
      () => (this.shell.mcpOpen() ? this.shell.closeMcp() : this.shell.openMcp()),
      () => this.mcpEnabled(),
    );
    this.destroyRef.onDestroy(unbind);
    this.destroyRef.onDestroy(unbindMcp);
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
   * True when no session is in front on the tabbed host — the empty placeholder.
   * The host's workspace is still whatever it last was, so naming it here read as
   * "this empty panel belongs to the previous project". A host without the tab
   * strip (VS Code) has its own workspace and is never in this state.
   */
  protected readonly noSessionInFront = this.tabs.noSessionInFront;

  /** The compact button needs a conversation; with none it says so instead. */
  protected readonly compactTitle = computed(() =>
    this.noSessionInFront()
      ? 'Open a session to compact the conversation'
      : 'Compact the conversation (asks first)',
  );

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
    // The model belongs to the session; with none in front it is the last one's.
    const model = this.noSessionInFront() ? undefined : this.state().model;
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

  /** Opens the MCP manager; the panel fetches the status when it mounts. */
  protected openMcp(): void {
    this.shell.openMcp();
  }
}
