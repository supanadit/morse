import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import type {
  McpConfigScope,
  McpExposure,
  McpInspectionResult,
  McpServerInput,
} from '@morse/protocol';
import { McpState } from '../../core/mcp-state';
import { MorseService } from '../../core/morse.service';
import { ViewState } from '../../core/view-state';

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
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        overflow-y: auto;
        background: var(--morse-bg);
      }
      .page {
        max-width: 760px;
        margin: 0 auto;
        padding: 18px 18px 28px;
      }
      h2 {
        margin: 0 0 4px;
        font-size: 15px;
        font-weight: 600;
      }
      .lead {
        margin: 0 0 14px;
        color: var(--morse-fg-muted);
        font-size: 12px;
        line-height: 1.55;
      }
      .scope-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
      .scope-label {
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .segmented {
        display: inline-flex;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        overflow: hidden;
      }
      .segmented button {
        padding: 4px 12px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        cursor: pointer;
      }
      .segmented button.active {
        background: var(--morse-accent);
        color: var(--morse-accent-fg);
      }
      .field {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .field label {
        flex: none;
        width: 92px;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
      }
      .field input,
      .field select {
        flex: 1;
        min-width: 0;
        padding: 6px 9px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-bg);
        color: var(--morse-fg);
        font-size: 12.5px;
        font-family: inherit;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }
      .actions .spacer {
        flex: 1;
      }
      .error {
        margin-top: 8px;
        color: var(--morse-error);
        font-size: 12px;
        line-height: 1.5;
      }
      .result {
        margin-top: 16px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        overflow: hidden;
      }
      .result.ok {
        border-color: color-mix(in srgb, var(--morse-success) 55%, var(--morse-border));
      }
      .result.bad {
        border-color: color-mix(in srgb, var(--morse-error) 55%, var(--morse-border));
      }
      .result-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        background: var(--morse-hover);
        font-size: 12.5px;
        font-weight: 600;
      }
      .result-head .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--morse-error);
      }
      .result.ok .result-head .dot {
        background: var(--morse-success);
      }
      .result-head .muted {
        margin-left: auto;
        color: var(--morse-fg-muted);
        font-size: 11px;
        font-weight: 400;
      }
      .result-body {
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.55;
      }
      .caps {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0;
      }
      .caps .chip {
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--morse-hover);
        color: var(--morse-fg-muted);
        font-size: 10.5px;
      }
      .list {
        margin: 4px 0 0;
        padding: 0;
        list-style: none;
      }
      .list li {
        padding: 5px 0;
        border-top: 1px solid var(--morse-border);
      }
      .list .item-name {
        font-weight: 600;
        font-family: var(--morse-mono, ui-monospace, monospace);
        font-size: 11.5px;
      }
      .list .item-desc {
        color: var(--morse-fg-muted);
        font-size: 11px;
        overflow-wrap: anywhere;
      }
      .logs {
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
        color: var(--morse-fg-muted);
        font-family: var(--morse-mono, ui-monospace, monospace);
        font-size: 11px;
        white-space: pre-wrap;
        max-height: 160px;
        overflow: auto;
      }
      @media (max-width: 560px) {
        .field {
          flex-direction: column;
          align-items: stretch;
          gap: 3px;
        }
        .field label {
          width: auto;
        }
      }
    `,
  ],
})
export class McpEditor {
  private readonly morse = inject(MorseService);
  private readonly mcp = inject(McpState);
  private readonly viewState = inject(ViewState);

  protected readonly cwd = computed(() => this.morse.workspace().cwd);
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
