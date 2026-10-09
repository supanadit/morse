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
  protected readonly workspace = this.morse.workspace;
  /** The reader's chosen tool-call density, toggled from the toolbar. */
  protected readonly compactTools = computed(() => this.display.toolDisplay() === 'compact');
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
