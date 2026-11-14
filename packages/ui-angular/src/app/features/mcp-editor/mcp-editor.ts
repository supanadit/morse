import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import type {
  McpConfigScope,
  McpExposure,
  McpInspectionResult,
  McpMutation,
  McpServerInput,
  McpServerStatus,
} from '@morse/protocol';
import { McpState } from '../../state/mcp-state';
import { MorseService } from '../../host/morse.service';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { ViewState } from '../../host/view-state';

type AddType = 'stdio' | 'http';

/** One editable key/value pair (an env variable or an HTTP header). */
interface McpPairRow {
  key: string;
  value: string;
}

/** What the editor restores after a reload, so a refresh never eats a draft. */
interface McpEditorDraft {
  name: string;
  type: AddType;
  command: string;
  argsText: string;
  workdir?: string;
  url: string;
  exposure: McpExposure;
  scope: McpConfigScope;
  env?: McpPairRow[];
  headers?: McpPairRow[];
  inspected?: McpInspectionResult;
}

const DRAFT_KEY = 'mcp-editor';

/**
 * The MCP editor: build a server, probe it, then save it. It lives in a tab (the
 * browser host) or in its own VS Code editor panel — never in the manager modal,
 * which is for toggling servers that already exist.
 *
 * The probe is Morse's own MCP client (see `integration-pi/internal/mcp-client`):
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
  /** A stdio server's working directory, when it needs one. */
  protected readonly workdir = signal('');
  protected readonly exposure = signal<McpExposure>('codemode');
  /** `KEY=value` rows for a stdio server. */
  protected readonly envRows = signal<McpPairRow[]>([]);
  /** `Header: value` rows for an http server. */
  protected readonly headerRows = signal<McpPairRow[]>([]);

  protected readonly testing = signal(false);
  protected readonly inspected = signal<McpInspectionResult | undefined>(undefined);
  protected readonly formError = signal<string | null>(null);
  protected readonly adding = signal(false);
  protected readonly added = signal(false);

  protected readonly isHttp = computed(() => this.type() === 'http');
  /** OpenCode has no exposure concept: the pi-only dropdown would be a no-op. */
  protected readonly piShaped = computed(() => this.mcp.engine() !== 'opencode');
  /** The row the panel asked to edit; absent means this is a new server. */
  protected readonly editingName = computed(() => this.mcp.editing()?.name);
  protected readonly isEditing = computed(() => this.editingName() !== undefined);

  /** The edit request this form already loaded, so it is not reloaded every tick. */
  private loadedEditToken: number | undefined;
  /**
   * The argument list an edited entry arrived with. `argsText` is a
   * whitespace-joined view, so an argument that contains a space cannot survive
   * the round trip; untouched arguments are therefore sent back verbatim.
   */
  private originalArgs: string[] = [];

  constructor() {
    // A reload (browser refresh, VS Code window reload, panel re-open) must not
    // eat a half-filled entry: hydrate first, then keep the host's store current.
    const draft = this.viewState.read<McpEditorDraft>(DRAFT_KEY);
    if (draft !== undefined) {
      if (typeof draft.name === 'string') this.name.set(draft.name);
      if (draft.type === 'http' || draft.type === 'stdio') this.type.set(draft.type);
      if (typeof draft.command === 'string') this.command.set(draft.command);
      if (typeof draft.argsText === 'string') this.argsText.set(draft.argsText);
      if (typeof draft.workdir === 'string') this.workdir.set(draft.workdir);
      if (typeof draft.url === 'string') this.url.set(draft.url);
      if (draft.exposure !== undefined) this.exposure.set(draft.exposure);
      if (draft.scope === 'project' || draft.scope === 'global') this.scope.set(draft.scope);
      if (draft.inspected !== undefined) this.inspected.set(draft.inspected);
      this.envRows.set(pairRows(draft.env));
      this.headerRows.set(pairRows(draft.headers));
    }
    // No project in front: a project entry has nowhere to be written, so the
    // form starts (and stays) on Global rather than offering a dead choice.
    effect(() => {
      if (this.noProject()) {
        this.scope.set('global');
      }
    });
    // The panel's Edit opens this form on an existing row. The token in the
    // request is what makes a second click reload it instead of keeping the
    // half-typed edits; clearing the request (Add server) empties the form.
    effect(() => {
      const request = this.mcp.editRequest();
      if (request?.token === this.loadedEditToken) {
        return;
      }
      const wasEditing = this.loadedEditToken !== undefined;
      this.loadedEditToken = request?.token;
      if (request === undefined) {
        if (wasEditing) {
          this.resetForm();
        }
        return;
      }
      this.loadServer(request.server);
    });
    effect(() => {
      // Reading every field here is what re-runs this on a keystroke. Once the
      // server is saved the draft is cleared rather than kept as a stale form.
      const draft: McpEditorDraft = {
        name: this.name(),
        type: this.type(),
        command: this.command(),
        argsText: this.argsText(),
        workdir: this.workdir(),
        url: this.url(),
        exposure: this.exposure(),
        scope: this.scope(),
        env: this.envRows(),
        headers: this.headerRows(),
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
  protected setWorkdir(value: string): void {
    this.workdir.set(value);
    this.added.set(false);
  }
  /** Prefill the form from a listed server, so Edit starts from the real entry. */
  private loadServer(server: McpServerStatus): void {
    const config = server.config;
    this.name.set(server.name);
    this.type.set(config?.type === 'http' ? 'http' : 'stdio');
    this.command.set(config?.command ?? '');
    this.originalArgs = config?.args === undefined ? [] : [...config.args];
    this.argsText.set(this.originalArgs.join(' '));
    this.workdir.set(config?.cwd ?? '');
    this.url.set(config?.url ?? '');
    this.exposure.set(config?.exposure ?? 'codemode');
    this.envRows.set(pairsOf(config?.env));
    this.headerRows.set(pairsOf(config?.headers));
    // The scope is the one that defines the row, not the panel's last choice:
    // saving an entry back into another file would duplicate it.
    this.scope.set(server.scope === 'project' ? 'project' : 'global');
    this.inspected.set(undefined);
    this.added.set(false);
    this.formError.set(null);
  }

  /** Add server means a blank form, not the last edited entry. */
  private resetForm(): void {
    this.name.set('');
    this.type.set('stdio');
    this.command.set('');
    this.originalArgs = [];
    this.argsText.set('');
    this.workdir.set('');
    this.url.set('');
    this.exposure.set('codemode');
    this.envRows.set([]);
    this.headerRows.set([]);
    this.scope.set(this.noProject() ? 'global' : 'project');
    this.inspected.set(undefined);
    this.added.set(false);
    this.formError.set(null);
  }

  protected setExposure(value: string): void {
    const allowed: McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden'];
    const match = allowed.find((entry) => entry === value);
    if (match) {
      this.exposure.set(match);
      this.added.set(false);
    }
  }
  /**
   * Why a scope button is unavailable. Editing keeps the entry's own scope:
   * writing it into another file would leave the original behind as a duplicate.
   */
  protected scopeHint(project: boolean): string {
    if (this.isEditing()) {
      return 'An existing server is saved back to the file that defines it.';
    }
    if (project && this.noProject()) {
      return 'Open a session to save into its project';
    }
    return '';
  }

  protected setScope(value: McpConfigScope): void {
    this.scope.set(value);
    this.added.set(false);
  }

  /** `KEY=value` rows; an empty set writes no `env`, which is the engine default. */
  protected addEnv(): void {
    this.envRows.update((rows) => [...rows, { key: '', value: '' }]);
    this.added.set(false);
  }
  protected setEnvKey(index: number, key: string): void {
    this.patchRow(this.envRows, index, { key });
  }
  protected setEnvValue(index: number, value: string): void {
    this.patchRow(this.envRows, index, { value });
  }
  protected removeEnv(index: number): void {
    this.envRows.update((rows) => rows.filter((_, at) => at !== index));
    this.added.set(false);
  }

  /** `Header: value` rows for an http server. */
  protected addHeader(): void {
    this.headerRows.update((rows) => [...rows, { key: '', value: '' }]);
    this.added.set(false);
  }
  protected setHeaderKey(index: number, key: string): void {
    this.patchRow(this.headerRows, index, { key });
  }
  protected setHeaderValue(index: number, value: string): void {
    this.patchRow(this.headerRows, index, { value });
  }
  protected removeHeader(index: number): void {
    this.headerRows.update((rows) => rows.filter((_, at) => at !== index));
    this.added.set(false);
  }

  private patchRow(
    rows: WritableSignal<McpPairRow[]>,
    index: number,
    patch: Partial<McpPairRow>,
  ): void {
    rows.update((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
    this.added.set(false);
  }

  /** The entry as it would be written; `undefined` when a required field is empty. */
  private toInput(): McpServerInput | undefined {
    const target = this.isHttp() ? this.url().trim() : this.command().trim();
    if (target.length === 0) {
      this.formError.set(this.isHttp() ? 'Enter the server URL.' : 'Enter the command to run.');
      return undefined;
    }
    const pairs = this.pairsToRecord(
      this.isHttp() ? this.headerRows() : this.envRows(),
      this.isHttp() ? 'header' : 'variable',
    );
    if (pairs === undefined) {
      return undefined;
    }
    this.formError.set(null);
    const editing = this.mcp.editing();
    return {
      name: this.name().trim(),
      scope: this.scope(),
      type: this.type(),
      // A save rewrites the whole entry, so its own on/off state has to travel
      // with it. A project override is that project's pin, not the entry's own
      // state, so it is left to the toggle instead of being written back.
      ...(editing === undefined || editing.override !== undefined
        ? {}
        : { enabled: editing.enabled }),
      ...(this.isHttp()
        ? { url: target, ...(Object.keys(pairs).length > 0 ? { headers: pairs } : {}) }
        : {
            command: target,
            args:
              this.argsText() === this.originalArgs.join(' ')
                ? [...this.originalArgs]
                : splitMcpArgs(this.argsText()),
            ...(this.workdir().trim().length > 0 ? { cwd: this.workdir().trim() } : {}),
            ...(Object.keys(pairs).length > 0 ? { env: pairs } : {}),
          }),
      exposure: this.exposure(),
    };
  }

  /**
   * The rows as the record both engines store. A value without a name is refused
   * rather than silently dropped: the reader typed it, so it should not vanish.
   */
  private pairsToRecord(
    rows: McpPairRow[],
    kind: 'header' | 'variable',
  ): Record<string, string> | undefined {
    const record: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key.length === 0) {
        if (row.value.trim().length > 0) {
          this.formError.set(`Name the ${kind} before saving.`);
          return undefined;
        }
        continue;
      }
      record[key] = row.value;
    }
    return record;
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
      this.formError.set(this.refusalMessage(result));
    }
  }

  /**
   * A refused save always says why. A `normalize` refusal (a JSONC file the host
   * will not rewrite behind the reader's back) names the one action that clears
   * it: Fix in the MCP manager, or a hand edit where this host has no Fix.
   */
  private refusalMessage(result: McpMutation): string {
    const normalize = result.issues?.find((issue) => issue.code === 'normalize');
    if (normalize === undefined) {
      return result.message ?? 'The host did not add the server.';
    }
    const file = normalize.file.length > 0 ? normalize.file : 'The config file';
    return this.mcp.canFix()
      ? `${file} must be rewritten before it can change: press Fix on it in the MCP manager, then save again.`
      : `${file} must be edited by hand (rewrite it as strict JSON), then save again.`;
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

/** A stored record as editable rows, in the file's own key order. */
function pairsOf(record: Record<string, string> | undefined): McpPairRow[] {
  if (record === undefined) {
    return [];
  }
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

/** A restored draft's rows, tolerating a draft written before rows existed. */
function pairRows(value: unknown): McpPairRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (row): row is McpPairRow =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as { key?: unknown }).key === 'string' &&
      typeof (row as { value?: unknown }).value === 'string',
  );
}

/** Split a command line the way a shell would for simple cases; quotes are not interpreted. */
export function splitMcpArgs(value: string): string[] {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
