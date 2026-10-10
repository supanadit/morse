import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MorseService } from '../../host/morse.service';
import { WorkspaceTabs } from '../../state/workspace-tabs';

/**
 * The window's bottom bar: the facts that are true of the window rather than of the
 * conversation in front — which host is serving it, which project it is rooted at, and how
 * much is open. What the conversation is doing stays in the chat header.
 */
@Component({
  selector: 'morse-status-bar',
  templateUrl: './status-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './status-bar.css',
})
export class StatusBar {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);

  /** Which host is serving this window: a VS Code webview, or the NestJS/browser host. */
  protected readonly hostLabel = computed(() =>
    this.morse.capabilities()?.hostKind === 'vscode' ? 'VS Code' : 'Browser host',
  );

  protected readonly workspace = computed(() => this.morse.workspace());

  /**
   * Only a host with a tab strip has tabs to count. VS Code keeps its own editor
   * tabs and hides the strip (`filePreview: false`), so a count of its internal
   * session tabs would name something the reader cannot see or close.
   */
  protected readonly showsTabs = computed(() => this.morse.capabilities()?.filePreview === true);

  protected readonly tabCount = computed(() => this.tabs.tabs().length);
}
