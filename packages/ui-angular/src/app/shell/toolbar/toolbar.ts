import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { MorseService } from '../../host/morse.service';
import { LayoutState } from '../../state/layout-state';
import { DisplayPrefs } from '../../state/display-prefs';
import { McpState } from '../../state/mcp-state';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { ShortcutService } from '../../services/shortcut.service';

/**
 * The window's top bar.
 *
 * It holds what belongs to the *window* rather than to the conversation in front: who this
 * is, the way into every command, the agent's lifecycle, the conversation's own buttons
 * (the tool-call display and compact), and the switches that change the window's own shape
 * — the navigation column, the git column, the MCP manager. What is left in the chat
 * header is what a conversation says: its title and its meta line.
 *
 * It is not rendered into a host surface that already has its own chrome (a VS Code editor
 * tab, see `app.html`), so the drawer toggle and the fold are always available here rather
 * than behind the header's `embedded` guard.
 */
@Component({
  selector: 'morse-toolbar',
  templateUrl: './toolbar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './toolbar.css',
})
export class Toolbar {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly display = inject(DisplayPrefs);
  private readonly layout = inject(LayoutState);
  private readonly mcp = inject(McpState);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly shortcuts = inject(ShortcutService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly paletteOpen = this.shell.paletteOpen;
  protected readonly navigationOpen = this.shell.navigationOpen;

  protected readonly state = this.morse.state;
  /** The happy path lives in the dot: no banner needed while it is healthy. */
  protected readonly status = computed(() => {
    const connection = this.morse.connection();
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
    const detail = this.morse.connectionDetail();
    return detail ? `${this.statusLabel()} · ${detail}` : this.statusLabel();
  });
  /** The reader's chosen tool-call density, toggled from this bar. */
  protected readonly compactTools = computed(() => this.display.toolDisplay() === 'compact');
  /**
   * True when no session is in front on the tabbed host — the empty placeholder.
   * The display switch is absent then, and the compact button says so instead.
   */
  protected readonly noSessionInFront = this.tabs.noSessionInFront;

  /** The compact button needs a conversation; with none it says so instead. */
  protected readonly compactTitle = computed(() =>
    this.noSessionInFront()
      ? 'Open a session to compact the conversation'
      : 'Compact the conversation (asks first)',
  );
  /** Wide layouts: the sidebar is folded away, and this button brings it back. */
  protected readonly collapsed = this.layout.leftCollapsed;
  /** The git column's switch only exists where the host can answer `gitLog`, and only
   * when a session is in front — with none there is no project to show. */
  protected readonly gitEnabled = computed(
    () => this.morse.capabilities()?.gitPanel === true && !this.tabs.noSessionInFront(),
  );
  protected readonly gitOpen = this.layout.rightVisible;
  /**
   * The MCP indicator exists where the host can run the `pi` CLI. It is usable without a
   * session too — the panel is then global-only (the user's own `mcp.json`), so this is
   * not gated on a session being in front.
   */
  protected readonly mcpEnabled = this.mcp.enabled;
  protected readonly mcpOverall = computed(() => this.mcp.overall(this.mcp.cwd()));
  protected readonly mcpTitle = computed(() => {
    const label = this.mcp.label(this.mcp.cwd());
    return this.mcpEnabled() ? `${label} — click to manage` : label;
  });

  constructor() {
    // The bar owns these buttons, so it owns their keys too: an unavailable row (a host
    // without `gitPanel`) is shown as unavailable rather than promised.
    const unbindGit = this.shortcuts.bind(
      'view.git',
      () => this.layout.toggleVisible('right'),
      () => this.gitEnabled(),
    );
    const unbindMcp = this.shortcuts.bind(
      'view.mcp',
      () => (this.shell.mcpOpen() ? this.shell.closeMcp() : this.shell.openMcp()),
      () => this.mcpEnabled(),
    );
    this.destroyRef.onDestroy(unbindGit);
    this.destroyRef.onDestroy(unbindMcp);
  }

  protected openPalette(): void {
    this.shell.togglePalette();
  }

  /** Flips between the detailed timeline and the compact summary, and remembers it. */
  protected toggleToolDisplay(): void {
    this.display.toggleToolDisplay();
  }

  protected compact(): void {
    // Never straight to the agent: the dialog owns the question (see ShellState).
    this.shell.requestCompact();
  }

  protected toggleNavigation(): void {
    this.shell.toggleNavigation();
  }

  /** The wide-layout twin of `toggleNavigation`: fold the column, not the drawer. */
  protected toggleSidebar(): void {
    this.layout.toggleVisible('left');
  }

  /** Shows or hides the browser host's git column. */
  protected toggleGit(): void {
    this.layout.toggleVisible('right');
  }

  /** Opens the MCP manager; the panel fetches the status when it mounts. */
  protected openMcp(): void {
    this.shell.openMcp();
  }
}
