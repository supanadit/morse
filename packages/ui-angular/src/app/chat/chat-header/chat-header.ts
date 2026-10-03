import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';

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
        border-bottom: 1px solid var(--morse-border);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 40px;
        padding: 6px 8px;
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
      @media (max-width: 759px) {
        .menu {
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
  /** The browser host asks which folder a new session belongs to. */
  private readonly directoryPicker = computed(
    () => this.morse.capabilities()?.directoryPicker === true,
  );

  protected readonly state = this.morse.state;
  protected readonly connection = this.morse.connection;
  protected readonly connectionDetail = this.morse.connectionDetail;
  protected readonly workspace = this.morse.workspace;
  protected readonly navigationOpen = this.shell.navigationOpen;

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

  protected readonly title = computed(
    () => this.state().sessionTitle || this.workspace().name || 'Morse',
  );

  /**
   * One muted line under the title. The workspace name is only repeated when it
   * is not already the title — a fresh session used to read "morse" twice.
   */
  protected readonly meta = computed(() => {
    const parts: string[] = [];
    const workspaceName = this.workspace().name;
    if (workspaceName && workspaceName !== this.title()) {
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

  protected newSession(): void {
    // No workspace folder here (browser host): ask which project, do not guess.
    if (this.directoryPicker()) {
      this.shell.openProjectPicker();
      return;
    }
    this.morse.newSession(this.workspace().cwd);
  }

  protected compact(): void {
    this.morse.compactSession();
  }
}
