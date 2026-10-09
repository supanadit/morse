import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MorseService } from '../../host/morse.service';
import { WorkspaceTabs } from '../../state/workspace-tabs';

/** The conversation view: its title and its meta line. The conversation's
 * buttons moved to the toolbar, beside the window's own indicators. */
@Component({
  selector: 'morse-chat-header',
  templateUrl: './header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './header.css',
})
export class ChatHeader {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);

  protected readonly state = this.morse.state;
  protected readonly workspace = this.morse.workspace;
  /**
   * True when no session is in front on the tabbed host — the empty placeholder.
   * The host's workspace is still whatever it last was, so naming it here read as
   * "this empty panel belongs to the previous project". A host without the tab
   * strip (VS Code) has its own workspace and is never in this state.
   */
  protected readonly noSessionInFront = this.tabs.noSessionInFront;

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
}
