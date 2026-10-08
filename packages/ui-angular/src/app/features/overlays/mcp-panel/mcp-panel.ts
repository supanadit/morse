import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  signal,
} from '@angular/core';
import type { McpConfigScope, McpServerStatus } from '@morse/protocol';
import { McpState } from '../../../state/mcp-state';
import { MorseService } from '../../../host/morse.service';
import { ShellState } from '../../../state/shell-state';
import { WorkspaceTabs } from '../../../state/workspace-tabs';

/** Where the panel's edits land; `project` writes a per-directory override for user servers. */
type EditScope = McpConfigScope;

/**
 * The MCP manager (`capabilities.mcp`): every server pi sees for the viewing
 * session's directory, its connection state, and the controls to add, remove,
 * enable or disable one. State comes from `pi mcp list --json`; edits go to the
 * same `mcp.json` pi reads.
 */
@Component({
  selector: 'morse-mcp-panel',
  templateUrl: './mcp-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgb(0 0 0 / 45%);
      }
      .modal-card {
        display: flex;
        flex-direction: column;
        width: min(620px, 100%);
        max-height: min(78vh, 720px);
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        overflow: hidden;
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      h2 {
        margin: 0;
        font-size: 13.5px;
        font-weight: 600;
      }
      .cwd {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .icon {
        flex: none;
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        cursor: pointer;
      }
      .icon:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 6px 8px 10px;
      }
      .hint {
        padding: 10px 8px;
        color: var(--morse-fg-muted);
        font-size: 12px;
        line-height: 1.55;
      }
      .scope-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 6px 8px;
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
        padding: 3px 10px;
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
      .note {
        margin: 8px 6px;
        padding: 8px 10px;
        border: 1px solid var(--morse-warn);
        border-radius: var(--morse-radius-sm);
        color: var(--morse-warn);
        font-size: 11.5px;
        line-height: 1.5;
      }
      .note .trust {
        margin-top: 8px;
        padding: 4px 10px;
        border: 1px solid var(--morse-warn);
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-warn);
        font: inherit;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .note .trust:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .add-note {
        margin: 4px 0 0;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .errors {
        margin: 8px 6px;
        padding: 8px 10px;
        border: 1px solid var(--morse-error);
        border-radius: var(--morse-radius-sm);
        color: var(--morse-error);
        font-size: 11.5px;
        line-height: 1.5;
      }
      .row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 8px;
        border-radius: var(--morse-radius-sm);
      }
      .row:hover {
        background: var(--morse-hover);
      }
      .dot {
        flex: none;
        width: 8px;
        height: 8px;
        margin-top: 5px;
        border-radius: 50%;
        background: var(--morse-fg-muted);
      }
      .dot.connected {
        background: var(--morse-success);
      }
      .dot.connecting,
      .dot.disconnected,
      .dot.needs-auth {
        background: var(--morse-warn);
      }
      .dot.failed,
      .dot.closed {
        background: var(--morse-error);
      }
      .dot.disabled {
        background: var(--morse-border);
      }
      .info {
        flex: 1;
        min-width: 0;
      }
      .name {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12.5px;
        font-weight: 600;
      }
      .name .server {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chip {
        flex: none;
        padding: 1px 5px;
        border-radius: 999px;
        background: var(--morse-hover);
        color: var(--morse-fg-muted);
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .chip.override {
        color: var(--morse-warn);
      }
      .meta {
        margin-top: 2px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .error {
        margin-top: 3px;
        color: var(--morse-error);
        font-size: 11px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: none;
      }
      .actions button {
        padding: 3px 8px;
        font-size: 11px;
      }
      .danger {
        color: var(--morse-error);
      }
      .add {
        margin: 4px 6px 0;
        padding: 10px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
      }
      .add h3 {
        margin: 0 0 8px;
        font-size: 12px;
        font-weight: 600;
      }
      .field {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .field label {
        flex: none;
        width: 74px;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .field input,
      .field select {
        flex: 1;
        min-width: 0;
        padding: 4px 7px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-bg);
        color: var(--morse-fg);
        font-size: 12px;
        font-family: inherit;
      }
      .add-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 8px;
      }
      footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-top: 1px solid var(--morse-border);
      }
      .spinner {
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      @media (max-width: 520px) {
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
export class McpPanel {
  private readonly morse = inject(MorseService);
  private readonly mcp = inject(McpState);
  private readonly shell = inject(ShellState);
  private readonly tabs = inject(WorkspaceTabs);

  protected readonly cwd = this.mcp.cwd;
  /** True when there is no project to scope to: the panel is global-only. */
  protected readonly noProject = this.tabs.noSessionInFront;
  /** What the header prints: the directory, or a plain "global" when there is none. */
  protected readonly cwdLabel = computed(() =>
    this.noProject() ? 'Global — user mcp.json' : this.cwd(),
  );
  protected readonly status = computed(() => this.mcp.status(this.cwd()));
  protected readonly loading = computed(() => this.mcp.isLoading(this.cwd()));
  protected readonly servers = computed(() => this.status()?.servers ?? []);
  protected readonly errors = computed(() => this.status()?.errors ?? []);
  protected readonly note = computed(() => this.status()?.note);
  /** pi is ignoring this project's `.pi` resources until it is trusted. */
  protected readonly untrusted = computed(() => this.status()?.trusted === false);
  protected readonly trusting = signal(false);
  protected readonly enabledServers = computed(() =>
    this.servers().filter((server) => server.enabled),
  );

  /** The row whose Remove button is waiting for a second click. */
  protected readonly pendingRemove = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** A refused enable/disable/remove, shown above the list. */
  protected readonly actionError = signal<string | null>(null);

  /**
   * Where Enable/Disable and Remove write. `project` is the default: the panel
   * is opened for one session's directory, and a user-level server is turned off
   * here with a project override rather than for every project.
   */
  protected readonly editScope = signal<EditScope>('project');

  constructor() {
    // Opening the panel is what triggers the (slow) list; it refreshes again
    // when the panel is pointed at another directory. With no session the
    // directory is `''` (global only), which the host reads without a project —
    // so the user's own servers stay manageable from the empty view.
    effect(() => {
      void this.mcp.refresh(this.cwd());
    });
    // No session means no project scope: fold the choice back to Global so an
    // enable/disable cannot land in the last project behind the reader's back.
    effect(() => {
      if (this.noProject()) {
        this.editScope.set('global');
      }
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.shell.closeMcp();
  }

  protected close(): void {
    this.shell.closeMcp();
  }

  protected refresh(): void {
    void this.mcp.refresh(this.cwd(), true);
  }

  /**
   * The trust prompt, answered from here: writes the same decision pi's own
   * prompt would, so the project's `.pi/mcp.json` (and settings, skills,
   * prompts) load without the reader going to a terminal. The refresh that
   * follows shows the project servers pi was ignoring.
   */
  protected async trustProject(): Promise<void> {
    if (this.trusting() || !this.cwd()) {
      return;
    }
    this.trusting.set(true);
    const result = await this.mcp.trustProject(this.cwd());
    this.trusting.set(false);
    if (!result.ok) {
      this.actionError.set(result.message ?? 'The host could not trust the project.');
    } else {
      this.actionError.set(null);
    }
  }

  protected stateLabel(server: McpServerStatus): string {
    switch (server.state) {
      case 'connected':
        return server.tools.length === 1 ? '1 tool' : `${server.tools.length} tools`;
      case 'connecting':
        return 'connecting…';
      case 'needs-auth':
        return 'needs sign-in';
      case 'disconnected':
        return 'disconnected';
      case 'failed':
        return 'failed';
      case 'closed':
        return 'closed';
      case 'disabled':
        return 'disabled';
      default:
        return server.state;
    }
  }

  protected async toggleEnabled(server: McpServerStatus): Promise<void> {
    if (this.busy() || !this.canEdit(server)) {
      return;
    }
    const scope = this.editScope();
    // In project scope a user-level server is turned off here; enabling removes
    // the override so the global value applies again.
    const enabled = scope === 'project' && server.scope !== 'project' ? false : !server.enabled;
    this.busy.set(true);
    const result = await this.mcp.setEnabled(server.name, enabled, this.cwd(), scope);
    this.busy.set(false);
    this.report(result.ok, result.message);
  }

  protected async remove(server: McpServerStatus): Promise<void> {
    if (!this.canRemove(server)) {
      return;
    }
    if (this.pendingRemove() !== server.name) {
      this.pendingRemove.set(server.name);
      return;
    }
    if (this.busy()) {
      return;
    }
    this.pendingRemove.set(null);
    this.busy.set(true);
    const result = await this.mcp.remove(server.name, this.cwd(), this.editScope());
    this.busy.set(false);
    this.report(result.ok, result.message);
  }

  /** Removing in project scope only makes sense for a project entry or override. */
  protected canRemove(server: McpServerStatus): boolean {
    return this.editScope() === 'project'
      ? server.scope === 'project'
      : server.scope !== 'project';
  }

  /** A project-defined server cannot be toggled from the global file, and vice versa. */
  protected canEdit(server: McpServerStatus): boolean {
    if (server.scope === 'extension') {
      return false;
    }
    return this.editScope() === 'project' ? true : server.scope === 'global';
  }

  /** What the row's toggle does in the current scope, so the button never lies. */
  protected toggleLabel(server: McpServerStatus): string {
    if (this.editScope() === 'project' && server.scope !== 'project') {
      return server.override ? 'Enable here' : 'Disable here';
    }
    return server.enabled ? 'Disable' : 'Enable';
  }

  protected editHint(server: McpServerStatus): string {
    if (server.scope === 'extension') {
      return 'Registered by an extension; it is not in an mcp.json.';
    }
    if (!this.canEdit(server)) {
      return `Defined in this project — switch the scope to “This project” to change it.`;
    }
    return '';
  }

  /**
   * Opens the MCP editor. The browser host has a tab strip, so the editor is a
   * tab there; VS Code has no Morse tabs, so the host opens its own editor panel
   * instead. Either way the manager closes — it is the list, not the form.
   */
  protected openAdd(): void {
    if (this.morse.capabilities()?.filePreview === true) {
      this.tabs.openMcp();
    } else {
      void this.morse.requestHostCommand('openMcpEditor', {}).catch(() => undefined);
    }
    this.shell.closeMcp();
  }

  private report(ok: boolean, message?: string): void {
    this.actionError.set(ok ? null : (message ?? 'The host did not apply the change.'));
  }
}
