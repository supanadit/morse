import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MorseService } from '../../host/morse.service';

/**
 * What a fresh install shows when the agent itself is missing.
 *
 * Morse is only the interface: without a coding-agent CLI there is nothing to
 * talk to, and a multi-line spawn error ("The pi coding agent was not found.
 * Install it (`npm install -g …`) or point Morse at it: …") is a log line, not a
 * screen — least of all in a VS Code sidebar. So the host classifies the failure
 * (`agentFailure.code`), the adapter names the install command, and this renders
 * the three things that matter: what is missing, the one command that fixes it,
 * and the host's own next step. The engine's label comes from the host, so an
 * OpenCode failure does not blame pi.
 *
 * A host with **no engine at all** is a second, deliberately different case:
 * there is no engine to blame, and Morse itself is engine-agnostic, so the
 * screen offers every engine the host can drive (`capabilities.engineSetup`)
 * instead of naming one. Both hosts send it, so a browser and a VS Code sidebar
 * show the same choice.
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
  /**
   * The engine this panel is about: the draft's choice, else the host's
   * default. A host with no engine catalog predates engine selection and only
   * runs pi, so pi is the honest fallback rather than a blank.
   */
  private readonly engine = computed(() => {
    const choice = this.morse.engine();
    const engines = this.morse.engines();
    const picked =
      engines.find((candidate) => candidate.kind === choice) ??
      engines.find((candidate) => candidate.default === true) ??
      engines[0];
    return { kind: picked?.kind ?? 'pi', label: picked?.label ?? 'pi' };
  });
  protected readonly engineLabel = computed(() => this.engine().label);
  protected readonly engineKind = computed(() => this.engine().kind);
  /**
   * Nothing is installed. A host that reports an empty engine list is saying
   * exactly that; one that omits the list predates engine selection and is
   * still a pi host, so it keeps the single-engine screen below.
   */
  protected readonly noEngine = computed(() => {
    const capabilities = this.morse.capabilities();
    return capabilities?.engines !== undefined && capabilities.engines.length === 0;
  });
  /** Every engine this host can install, in the host's own words. */
  protected readonly setup = this.morse.engineSetup;
  /**
   * The footnotes below name pi's own setting and environment variable. They
   * are worse than useless on an OpenCode host, which resolves its own binary.
   */
  protected readonly isPi = computed(() => this.engine().kind === 'pi');
  /** The one case with a known fix: pi is not there. The rest gets generic wording. */
  protected readonly missing = computed(() => this.failure()?.code === 'agent-unavailable');
  protected readonly install = computed(() => this.failure()?.install ?? '');
  protected readonly hint = computed(() => this.failure()?.hint ?? '');
  /**
   * Only VS Code answers `openSettings` / `showOutput`; the browser host's
   * equivalent is a terminal command, which the footnote spells out instead.
   */
  protected readonly hasEditor = computed(() => this.morse.capabilities()?.hostKind === 'vscode');
  /** Which row was copied last, so a second row does not show another's "Copied". */
  private readonly copiedKind = signal<string | undefined>(undefined);

  protected copied(kind: string): boolean {
    return this.copiedKind() === kind;
  }

  protected copyInstall(command: string, kind: string): void {
    if (command.length === 0) {
      return;
    }
    void navigator.clipboard?.writeText(command);
    this.copiedKind.set(kind);
    setTimeout(() => {
      if (this.copiedKind() === kind) {
        this.copiedKind.set(undefined);
      }
    }, 1_600);
  }

  /** Same retry as the banner: a new session is what makes the host spawn the agent again. */
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
