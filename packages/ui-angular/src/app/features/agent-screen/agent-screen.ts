import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MorseService } from '../../host/morse.service';

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
  styleUrl: './agent-screen.css',
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
