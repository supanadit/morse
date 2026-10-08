import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import type {
  McpConfigScope,
  McpInspectionResult,
  McpServerInput,
  McpServerStatus,
  McpStatus,
  McpMutation,
  ProjectTrustResult,
} from '@morse/protocol';
import { MorseService } from '../host/morse.service';
import { WorkspaceTabs } from './workspace-tabs';

/** A one-glance read of a directory's MCP health, for the header's dot. */
export type McpOverall = 'unknown' | 'loading' | 'ok' | 'warn' | 'error' | 'off';

/**
 * `pi mcp list` connects to every enabled server, so it is neither instant nor
 * free: a fetched status is reused for a minute, concurrent fetches for the same
 * directory share one round trip, and a mutation forces the next one.
 */
const STATUS_TTL_MS = 60_000;
/**
 * A window regaining focus forces a fresh list, but not a `pi mcp list` per
 * alt-tab: a fetch this recent is close enough that the reader has not edited
 * `mcp.json` in between.
 */
const FOCUS_MIN_INTERVAL_MS = 10_000;
/** The frontend's other host commands time out at 5 s; connecting to servers does not fit. */
const STATUS_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 15_000;
/** A probe spawns or dials a server and runs a whole MCP lifecycle. */
const INSPECT_TIMEOUT_MS = 45_000;

/**
 * The MCP servers of every directory the reader has looked at, as the host last
 * reported them. One store because two surfaces read it: the header's indicator
 * dot (always visible) and the manager panel (on demand). The panel owns the
 * mutations and refreshes; the dot only renders what was fetched.
 */
@Injectable({ providedIn: 'root' })
export class McpState {
  private readonly morse = inject(MorseService);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly destroyRef = inject(DestroyRef);

  private readonly byCwd = signal<Record<string, McpStatus>>({});
  private readonly loadingByCwd = signal<Record<string, boolean>>({});
  private readonly fetchedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<McpStatus | undefined>>();

  /** Only a host that can run the `pi` CLI advertises this. */
  readonly enabled = computed(() => this.morse.capabilities()?.mcp === true);

  /**
   * The directory the indicator and panel are about. `''` means **global only**:
   * no session in front, so the user's own `mcp.json` is the whole subject, and
   * the panel stays usable instead of showing another project's servers.
   */
  readonly cwd = computed(() =>
    this.tabs.noSessionInFront() ? '' : this.morse.workspace().cwd,
  );

  constructor() {
    // The header's indicator must mean something before the panel is opened, so
    // the active directory is probed in the background. `cwd()` is read here, in
    // the effect body, so the probe follows the directory: opening or switching a
    // session re-runs it. (Read inside the timeout it was untracked, so the dot
    // stayed on the global list until the panel was clicked.) The delay is a
    // debounce: switching tabs does not spawn a `pi mcp list` per step, and the
    // TTL means a directory is asked about at most once a minute. With no session
    // the probe is the global list (`''`).
    effect((onCleanup) => {
      if (!this.enabled()) {
        return;
      }
      const target = this.cwd();
      const timer = setTimeout(() => void this.refresh(target), 1_200);
      onCleanup(() => clearTimeout(timer));
    });
    // Coming back to the window is when an `mcp.json` edited elsewhere — in a
    // terminal, or by pi's own `/mcp` — should be picked up, instead of waiting
    // out the TTL. `focus` is the browser window, `visibilitychange` the VS Code
    // webview being re-shown.
    const onAwake = (): void => {
      if (!this.enabled()) {
        return;
      }
      const dir = this.cwd();
      if (Date.now() - (this.fetchedAt.get(dir) ?? 0) < FOCUS_MIN_INTERVAL_MS) {
        return;
      }
      void this.refresh(dir, true);
    };
    const doc = (globalThis as { document?: Document }).document;
    const win = globalThis as {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
    doc?.addEventListener('visibilitychange', onAwake);
    win.addEventListener?.('focus', onAwake);
    this.destroyRef.onDestroy(() => {
      doc?.removeEventListener('visibilitychange', onAwake);
      win.removeEventListener?.('focus', onAwake);
    });
    // The host watches the `mcp.json` files pi reads and pushes when one moves,
    // so an edit made in a terminal (or by another window) reaches the dot
    // without opening the manager. `''` is the user-level file, which every
    // project inherits, so it invalidates every cached directory.
    this.destroyRef.onDestroy(
      this.morse.onMcpChanged((event) => this.onExternalChange(event.cwd)),
    );
  }

  status(cwd: string): McpStatus | undefined {
    return this.byCwd()[cwd];
  }

  isLoading(cwd: string): boolean {
    return this.loadingByCwd()[cwd] === true;
  }

  /** The dot's colour: healthy, something to look at, broken, or nothing configured. */
  overall(cwd: string): McpOverall {
    const status = this.byCwd()[cwd];
    if (!status) {
      return this.isLoading(cwd) ? 'loading' : 'unknown';
    }
    if (status.errors.length > 0) {
      return 'error';
    }
    const enabled = status.servers.filter((server) => server.enabled);
    if (enabled.length === 0) {
      return 'off';
    }
    if (enabled.some((server) => server.state === 'failed' || server.state === 'closed')) {
      return 'error';
    }
    if (
      enabled.some(
        (server) =>
          server.state === 'connecting' ||
          server.state === 'disconnected' ||
          server.state === 'needs-auth',
      )
    ) {
      return 'warn';
    }
    return 'ok';
  }

  /** A sentence for the dot's tooltip, so the indicator is never a mystery. */
  label(cwd: string): string {
    switch (this.overall(cwd)) {
      case 'loading':
        return 'MCP: checking…';
      case 'ok':
        return `MCP: ${this.connectableCount(cwd)} connected`;
      case 'warn':
        return 'MCP: needs attention';
      case 'error':
        return 'MCP: a server failed';
      case 'off':
        return 'MCP: none enabled';
      default:
        return this.enabled() ? 'MCP servers' : 'MCP unavailable';
    }
  }

  private connectableCount(cwd: string): number {
    return (this.byCwd()[cwd]?.servers ?? []).filter(
      (server) => server.enabled && server.state === 'connected',
    ).length;
  }

  /**
   * The host saw an `mcp.json` move on disk: drop that directory's cache (or
   * every directory's, for the user-level file) and re-read what is in front.
   */
  private onExternalChange(cwd: string): void {
    if (cwd.length === 0) {
      this.fetchedAt.clear();
    } else {
      this.fetchedAt.delete(cwd);
    }
    const current = this.cwd();
    if (cwd.length === 0 || cwd === current) {
      void this.refresh(current, true);
    }
  }

  /**
   * Fetch a directory's status, reusing a recent answer unless `force` is set.
   * Resolves `undefined` when the host did not answer (an older host, a timeout).
   */
  async refresh(cwd: string, force = false): Promise<McpStatus | undefined> {
    const existing = this.inFlight.get(cwd);
    if (existing) {
      return existing;
    }
    const last = this.fetchedAt.get(cwd) ?? 0;
    if (!force && this.byCwd()[cwd] && Date.now() - last < STATUS_TTL_MS) {
      return this.byCwd()[cwd];
    }
    const promise = this.fetch(cwd);
    this.inFlight.set(cwd, promise);
    return promise.finally(() => {
      this.inFlight.delete(cwd);
    });
  }

  private async fetch(cwd: string): Promise<McpStatus | undefined> {
    this.setLoading(cwd, true);
    try {
      const data = await this.morse.requestHostCommand(
        'mcpStatus',
        cwd.length > 0 ? { cwd } : { scope: 'global' },
        STATUS_TIMEOUT_MS,
      );
      const status = asMcpStatus(data);
      if (status) {
        this.byCwd.update((map) => ({ ...map, [cwd]: status }));
        this.fetchedAt.set(cwd, Date.now());
      }
      return status;
    } finally {
      this.setLoading(cwd, false);
    }
  }

  async add(input: McpServerInput, cwd: string): Promise<McpMutation> {
    const result = await this.mutate('mcpAdd', { ...input }, cwd);
    return result;
  }
  /**
   * Connects to a server *before* it is added, so the reader can see its tools
   * (or the exact reason it will not connect). The host writes nothing; the
   * `cwd` scopes a spawn the same way a session does.
   */
  async inspect(input: McpServerInput, cwd: string): Promise<McpInspectionResult | undefined> {
    const data = await this.morse.requestHostCommand(
      'mcpInspect',
      { ...input, ...(cwd.length > 0 ? { cwd } : {}) },
      INSPECT_TIMEOUT_MS,
    );
    return asInspection(data);
  }

  async remove(name: string, cwd: string, scope: McpConfigScope): Promise<McpMutation> {
    return this.mutate('mcpRemove', { name, scope, ...(cwd.length > 0 ? { cwd } : {}) }, cwd);
  }

  async setEnabled(
    name: string,
    enabled: boolean,
    cwd: string,
    scope: McpConfigScope,
  ): Promise<McpMutation> {
    return this.mutate(
      'mcpSetEnabled',
      { name, enabled, scope, ...(cwd.length > 0 ? { cwd } : {}) },
      cwd,
    );
  }

  /**
   * Marks the viewing project trusted, so pi loads its `.pi` resources (the
   * project's `mcp.json` included). A status refresh follows, since the project
   * servers pi was ignoring should appear.
   */
  async trustProject(cwd: string): Promise<ProjectTrustResult> {
    const data = await this.morse.requestHostCommand('trustProject', { cwd }, MUTATION_TIMEOUT_MS);
    const result = asTrustResult(data);
    if (result.ok) {
      await this.refresh(cwd, true);
    }
    return result;
  }

  private async mutate(
    command: 'mcpAdd' | 'mcpRemove' | 'mcpSetEnabled',
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<McpMutation> {
    const data = await this.morse.requestHostCommand(command, args, MUTATION_TIMEOUT_MS);
    const result = asMcpMutation(data);
    if (result.ok) {
      await this.refresh(cwd, true);
    }
    return result;
  }

  private setLoading(cwd: string, loading: boolean): void {
    this.loadingByCwd.update((map) => ({ ...map, [cwd]: loading }));
  }
}

function asMcpStatus(value: unknown): McpStatus | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const row = value as { servers?: unknown; errors?: unknown; note?: unknown; trusted?: unknown };
  if (!Array.isArray(row.servers)) {
    return undefined;
  }
  return {
    servers: row.servers.filter(isServerStatus),
    errors: Array.isArray(row.errors) ? row.errors.filter(isString) : [],
    ...(typeof row.note === 'string' ? { note: row.note } : {}),
    ...(row.trusted === true ? { trusted: true } : row.trusted === false ? { trusted: false } : {}),
  };
}

function isServerStatus(value: unknown): value is McpServerStatus {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as { name?: unknown; state?: unknown };
  return typeof row.name === 'string' && typeof row.state === 'string';
}

function asMcpMutation(value: unknown): McpMutation {
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true) {
    const row = value as { path?: unknown; scope?: unknown; override?: unknown };
    return {
      ok: true,
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
      ...(row.scope === 'global' || row.scope === 'project' ? { scope: row.scope } : {}),
      ...(row.override === true ? { override: true } : {}),
    };
  }
  const message = typeof (value as { message?: unknown } | null)?.message === 'string'
    ? (value as { message: string }).message
    : 'The host did not apply the change.';
  return { ok: false, message };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function asTrustResult(value: unknown): ProjectTrustResult {
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true) {
    const row = value as { path?: unknown };
    return { ok: true, ...(typeof row.path === 'string' ? { path: row.path } : {}) };
  }
  const message =
    typeof (value as { message?: unknown } | null)?.message === 'string'
      ? (value as { message: string }).message
      : 'The host could not trust the project.';
  return { ok: false, message };
}

/**
 * A probe result, normalised just enough that a malformed answer renders as an
 * empty card rather than crashing the editor.
 */
function asInspection(value: unknown): McpInspectionResult | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const lists = (key: string): unknown[] => (Array.isArray(row[key]) ? (row[key] as unknown[]) : []);
  return {
    ok: row['ok'] === true,
    ...(isRecord(row['serverInfo'])
      ? { serverInfo: row['serverInfo'] as unknown as McpInspectionResult['serverInfo'] }
      : {}),
    ...(typeof row['protocolVersion'] === 'string'
      ? { protocolVersion: row['protocolVersion'] }
      : {}),
    ...(typeof row['instructions'] === 'string' ? { instructions: row['instructions'] } : {}),
    ...(isRecord(row['capabilities'])
      ? { capabilities: row['capabilities'] as unknown as McpInspectionResult['capabilities'] }
      : {}),
    tools: lists('tools') as McpInspectionResult['tools'],
    resources: lists('resources') as McpInspectionResult['resources'],
    resourceTemplates: lists('resourceTemplates') as McpInspectionResult['resourceTemplates'],
    prompts: lists('prompts') as McpInspectionResult['prompts'],
    ...(Array.isArray(row['logs']) ? { logs: row['logs'].filter(isString) } : {}),
    ...(isInspectionError(row['error']) ? { error: row['error'] } : {}),
    durationMs: typeof row['durationMs'] === 'number' ? row['durationMs'] : 0,
  };
}

function isInspectionError(value: unknown): value is McpInspectionResult['error'] {
  return isRecord(value) && typeof value['kind'] === 'string' && typeof value['message'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
