import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import type {
  McpConfigScope,
  McpExposure,
  McpInspectionResult,
  McpServerInput,
} from '@morse/protocol';
import { McpState } from '../../../state/mcp-state';
import { MorseService } from '../../../host/morse.service';
import { WorkspaceTabs } from '../../../state/workspace-tabs';
import { ViewState } from '../../../host/view-state';

type AddType = 'stdio' | 'http';

/** What the editor restores after a reload, so a refresh never eats a draft. */
interface McpEditorDraft {
  name: string;
  type: AddType;
  command: string;
  argsText: string;
  url: string;
  exposure: McpExposure;
  scope: McpConfigScope;
  inspected?: McpInspectionResult;
}

const DRAFT_KEY = 'mcp-editor';

/**
 * The MCP editor: build a server, probe it, then save it. It lives in a tab (the
 * browser host) or in its own VS Code editor panel — never in the manager modal,
 * which is for toggling servers that already exist.
 *
 * The probe is Morse's own MCP client (see `adapter-pi-rpc/internal/mcp-client`):
 * it connects, runs the lifecycle and lists what the server offers, so a server
 * that will not work is discovered here rather than after it is written into
 * `mcp.json`.
 */
@Component({
  selector: 'morse-mcp-editor',
  templateUrl: './mcp-editor.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './mcp-editor.css',
})
export class McpEditor {
  private readonly morse = inject(MorseService);
  private readonly mcp = inject(McpState);
  private readonly viewState = inject(ViewState);
  private readonly tabs = inject(WorkspaceTabs);

  /** No session in front: the form is global-only (the user's `mcp.json`). */
  protected readonly noProject = this.tabs.noSessionInFront;
  /** No project means no directory: the probe runs where the host defaults to. */
  protected readonly cwd = computed(() =>
    this.noProject() ? '' : this.morse.workspace().cwd,
  );
  protected readonly scope = signal<McpConfigScope>('project');
  protected readonly name = signal('');
  protected readonly type = signal<AddType>('stdio');
  protected readonly command = signal('');
  protected readonly argsText = signal('');
  protected readonly url = signal('');
  protected readonly exposure = signal<McpExposure>('codemode');

  protected readonly testing = signal(false);
  protected readonly inspected = signal<McpInspectionResult | undefined>(undefined);
  protected readonly formError = signal<string | null>(null);
  protected readonly adding = signal(false);
  protected readonly added = signal(false);

  protected readonly isHttp = computed(() => this.type() === 'http');

  constructor() {
    // A reload (browser refresh, VS Code window reload, panel re-open) must not
    // eat a half-filled entry: hydrate first, then keep the host's store current.
    const draft = this.viewState.read<McpEditorDraft>(DRAFT_KEY);
    if (draft !== undefined) {
      if (typeof draft.name === 'string') this.name.set(draft.name);
      if (draft.type === 'http' || draft.type === 'stdio') this.type.set(draft.type);
      if (typeof draft.command === 'string') this.command.set(draft.command);
      if (typeof draft.argsText === 'string') this.argsText.set(draft.argsText);
      if (typeof draft.url === 'string') this.url.set(draft.url);
      if (draft.exposure !== undefined) this.exposure.set(draft.exposure);
      if (draft.scope === 'project' || draft.scope === 'global') this.scope.set(draft.scope);
      if (draft.inspected !== undefined) this.inspected.set(draft.inspected);
    }
    // No project in front: a project entry has nowhere to be written, so the
    // form starts (and stays) on Global rather than offering a dead choice.
    effect(() => {
      if (this.noProject()) {
        this.scope.set('global');
      }
    });
    effect(() => {
      // Reading every field here is what re-runs this on a keystroke. Once the
      // server is saved the draft is cleared rather than kept as a stale form.
      const draft: McpEditorDraft = {
        name: this.name(),
        type: this.type(),
        command: this.command(),
        argsText: this.argsText(),
        url: this.url(),
        exposure: this.exposure(),
        scope: this.scope(),
        ...(this.inspected() !== undefined ? { inspected: this.inspected() } : {}),
      };
      this.viewState.write(DRAFT_KEY, this.added() ? undefined : draft);
    });
  }

  protected setName(value: string): void {
    this.name.set(value);
    this.added.set(false);
  }
  protected setType(value: string): void {
    this.type.set(value === 'http' ? 'http' : 'stdio');
    this.added.set(false);
  }
  protected setCommand(value: string): void {
    this.command.set(value);
    this.added.set(false);
  }
  protected setArgs(value: string): void {
    this.argsText.set(value);
    this.added.set(false);
  }
  protected setUrl(value: string): void {
    this.url.set(value);
    this.added.set(false);
  }
  protected setExposure(value: string): void {
    const allowed: McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden'];
    const match = allowed.find((entry) => entry === value);
    if (match) {
      this.exposure.set(match);
      this.added.set(false);
    }
  }
  protected setScope(value: McpConfigScope): void {
    this.scope.set(value);
    this.added.set(false);
  }

  /** The entry as it would be written; `undefined` when a required field is empty. */
  private toInput(): McpServerInput | undefined {
    const target = this.isHttp() ? this.url().trim() : this.command().trim();
    if (target.length === 0) {
      this.formError.set(this.isHttp() ? 'Enter the server URL.' : 'Enter the command to run.');
      return undefined;
    }
    this.formError.set(null);
    return {
      name: this.name().trim(),
      scope: this.scope(),
      type: this.type(),
      ...(this.isHttp() ? { url: target } : { command: target, args: splitMcpArgs(this.argsText()) }),
      exposure: this.exposure(),
    };
  }

  protected async test(): Promise<void> {
    if (this.testing() || this.adding()) {
      return;
    }
    const input = this.toInput();
    if (input === undefined) {
      return;
    }
    this.testing.set(true);
    this.inspected.set(undefined);
    try {
      const result = await this.mcp.inspect(input, this.cwd());
      this.inspected.set(result ?? undefined);
      if (result === undefined) {
        this.formError.set('The host did not answer the probe.');
      }
    } finally {
      this.testing.set(false);
    }
  }

  protected async add(): Promise<void> {
    if (this.adding() || this.testing()) {
      return;
    }
    const input = this.toInput();
    if (input === undefined) {
      return;
    }
    if (input.name.length === 0) {
      this.formError.set('Give the server a name.');
      return;
    }
    this.adding.set(true);
    const result = await this.mcp.add(input, this.cwd());
    this.adding.set(false);
    if (result.ok) {
      this.added.set(true);
      this.formError.set(null);
    } else {
      this.formError.set(result.message ?? 'The host did not add the server.');
    }
  }

  protected errorTitle(result: McpInspectionResult): string {
    switch (result.error?.kind) {
      case 'auth':
        return 'Needs sign-in';
      case 'unreachable':
        return 'Unreachable';
      case 'timeout':
        return 'Timed out';
      case 'protocol':
        return 'Protocol error';
      case 'spawn':
        return 'Could not start';
      default:
        return 'Could not connect';
    }
  }

  protected errorHint(result: McpInspectionResult): string | undefined {
    if (result.error?.kind === 'auth') {
      return result.error.authUrl
        ? `The server wants OAuth. Sign in with the web inspector or TUI for ${result.error.authUrl}, then test again.`
        : 'The server wants OAuth. Sign in with the web inspector or TUI, then test again.';
    }
    if (result.error?.kind === 'spawn') {
      return 'Check the command and that it is installed on the host machine.';
    }
    if (result.error?.kind === 'unreachable') {
      return 'Check the URL and that the server is running.';
    }
    return undefined;
  }

  protected capabilities(result: McpInspectionResult): string[] {
    const caps = result.capabilities ?? {};
    return (['tools', 'resources', 'prompts', 'logging', 'completions'] as const).filter(
      (key) => caps[key] === true,
    );
  }
}

/** Split a command line the way a shell would for simple cases; quotes are not interpreted. */
export function splitMcpArgs(value: string): string[] {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
