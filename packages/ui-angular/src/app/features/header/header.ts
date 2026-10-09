import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MorseService } from '../../host/morse.service';
import { DisplayPrefs } from '../../state/display-prefs';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';

@Component({
  selector: 'morse-chat-header',
  templateUrl: './header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './header.css',
})
export class ChatHeader {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly display = inject(DisplayPrefs);
  private readonly tabs = inject(WorkspaceTabs);

  protected readonly state = this.morse.state;
  /** The window's own buttons — the navigation fold, the git column, the MCP manager —
   * belong to the toolbar, which owns them and their keys (`shell/toolbar/`). What is
   * left here is about the conversation: its title, its meta line, and the agent's state. */
  protected readonly connection = this.morse.connection;
  protected readonly connectionDetail = this.morse.connectionDetail;
  protected readonly workspace = this.morse.workspace;
  /** The reader's chosen tool-call density, toggled from the toolbar. */
  protected readonly compactTools = computed(() => this.display.toolDisplay() === 'compact');
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

  protected compact(): void {
    // Never straight to the agent: the dialog owns the question (see ShellState).
    this.shell.requestCompact();
  }

  /** Flips between the detailed timeline and the compact summary, and remembers it. */
  protected toggleToolDisplay(): void {
    this.display.toggleToolDisplay();
  }
}
