import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MorseService } from '../core/morse.service';

/**
 * What a fresh install shows when the agent itself is missing.
 *
 * Morse is only the interface: without the pi CLI there is nothing to talk to,
 * and a multi-line spawn error ("The pi coding agent was not found. Install it
 * (`npm install -g …`) or point Morse at it: …") is a log line, not a screen —
 * least of all in a VS Code sidebar. So the host classifies the failure
 * (`agentFailure.code`), the adapter names the install command, and this renders
 * the three things that matter: what is missing, the one command that fixes it,
 * and the host's own next step.
 *
 * It takes over only an **empty** panel; with a transcript to read the failure
 * stays a bar above it (see `app.ts`), because old answers are still worth
 * reading with the agent down.
 */
@Component({
  selector: 'morse-agent-screen',
  templateUrl: './agent-screen.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 18px;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
        max-width: 520px;
        margin: auto;
        padding: 20px 22px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 10px 30px rgb(0 0 0 / 18%);
        color: var(--morse-fg);
        animation: agent-in 200ms ease-out;
      }
      .eyebrow {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        color: var(--morse-fg-muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      /* Amber, not red: nothing is broken, something is not installed yet. */
      .pip {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--morse-warn);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--morse-warn) 22%, transparent);
      }
      h1 {
        margin: 0;
        font-size: 17px;
        line-height: 1.35;
        font-weight: 600;
      }
      .body {
        margin: 0;
        color: var(--morse-fg-muted);
        font-size: 12.5px;
        line-height: 1.6;
      }
      .command {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 8px 8px 10px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-code-bg);
      }
      .command code {
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        white-space: nowrap;
        font-size: 12px;
        color: var(--morse-fg);
      }
      .command button {
        flex: none;
        padding: 3px 9px;
        font-size: 11px;
      }
      .hint {
        margin: 0;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
        line-height: 1.55;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 2px;
      }
      .foot {
        margin: 0;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1.5;
      }
      /*
       * The raw failure stays available — support asks for it, and it is the only
       * place the host's exact words are, but it never leads the screen.
       */
      details {
        border-top: 1px solid var(--morse-border);
        padding-top: 8px;
      }
      summary {
        color: var(--morse-fg-muted);
        font-size: 11px;
        cursor: pointer;
      }
      details pre {
        margin: 6px 0 0;
        padding: 8px;
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 11px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }
      @keyframes agent-in {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .card {
          animation: none;
        }
      }
    `,
  ],
})
export class AgentScreen {
  private readonly morse = inject(MorseService);

  /** The host's own words, shown verbatim under the details fold. */
  protected readonly message = this.morse.agentError;
  protected readonly failure = this.morse.agentFailure;
  /** The one case with a known fix: pi is not there. The rest gets generic wording. */
  protected readonly missing = computed(() => this.failure()?.code === 'agent-unavailable');
  protected readonly install = computed(() => this.failure()?.install ?? '');
  protected readonly hint = computed(() => this.failure()?.hint ?? '');
  /**
   * Only VS Code answers `openSettings` / `showOutput`; the browser host's
   * equivalent is a terminal command, which the footnote spells out instead.
   */
  protected readonly hasEditor = computed(() => this.morse.capabilities()?.hostKind === 'vscode');
  protected readonly copied = signal(false);

  protected copyInstall(): void {
    const command = this.install();
    if (command.length === 0) {
      return;
    }
    void navigator.clipboard?.writeText(command);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1_600);
  }

  /** Same retry as the banner: a new session is what makes the host spawn pi again. */
  protected retry(): void {
    this.morse.newSession();
  }

  protected openSettings(): void {
    this.morse.hostCommand('openSettings');
  }

  protected showLog(): void {
    this.morse.hostCommand('showOutput');
  }
}
