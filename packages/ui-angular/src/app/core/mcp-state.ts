import { computed, effect, inject, Injectable, signal } from '@angular/core';
import type {
  McpConfigScope,
  McpServerInput,
  McpServerStatus,
  McpStatus,
  McpMutation,
} from '@morse/protocol';
import { MorseService } from './morse.service';

/** A one-glance read of a directory's MCP health, for the header's dot. */
export type McpOverall = 'unknown' | 'loading' | 'ok' | 'warn' | 'error' | 'off';

/**
 * `pi mcp list` connects to every enabled server, so it is neither instant nor
 * free: a fetched status is reused for a minute, concurrent fetches for the same
 * directory share one round trip, and a mutation forces the next one.
 */
const STATUS_TTL_MS = 60_000;
/** The frontend's other host commands time out at 5 s; connecting to servers does not fit. */
const STATUS_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 15_000;

/**
 * The MCP servers of every directory the reader has looked at, as the host last
 * reported them. One store because two surfaces read it: the header's indicator
 * dot (always visible) and the manager panel (on demand). The panel owns the
 * mutations and refreshes; the dot only renders what was fetched.
 */
@Injectable({ providedIn: 'root' })
export class McpState {
  private readonly morse = inject(MorseService);

  private readonly byCwd = signal<Record<string, McpStatus>>({});
  private readonly loadingByCwd = signal<Record<string, boolean>>({});
  private readonly fetchedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<McpStatus | undefined>>();

  /** Only a host that can run the `pi` CLI advertises this. */
  readonly enabled = computed(() => this.morse.capabilities()?.mcp === true);

  constructor() {
    // The header's indicator must mean something before the panel is opened, so
    // the active directory is probed in the background. The delay is a debounce:
    // switching tabs does not spawn a `pi mcp list` per step, and the TTL means
    // a directory is asked about at most once a minute.
    effect((onCleanup) => {
      if (!this.enabled()) {
        return;
      }
      const cwd = this.morse.workspace().cwd;
      if (!cwd) {
        return;
      }
      const timer = setTimeout(() => {
        void this.refresh(cwd);
      }, 1_200);
      onCleanup(() => clearTimeout(timer));
    });
  }

  status(cwd: string): McpStatus | undefined {
    return cwd ? this.byCwd()[cwd] : undefined;
  }

  isLoading(cwd: string): boolean {
    return this.loadingByCwd()[cwd] === true;
  }

  /** The dot's colour: healthy, something to look at, broken, or nothing configured. */
  overall(cwd: string): McpOverall {
    if (!cwd) {
      return 'unknown';
    }
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
   * Fetch a directory's status, reusing a recent answer unless `force` is set.
   * Resolves `undefined` when the host did not answer (an older host, a timeout).
   */
  async refresh(cwd: string, force = false): Promise<McpStatus | undefined> {
    if (!cwd) {
      return undefined;
    }
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
        { cwd },
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

  async remove(name: string, cwd: string, scope: McpConfigScope): Promise<McpMutation> {
    return this.mutate('mcpRemove', { name, scope }, cwd);
  }

  async setEnabled(
    name: string,
    enabled: boolean,
    cwd: string,
    scope: McpConfigScope,
  ): Promise<McpMutation> {
    return this.mutate('mcpSetEnabled', { name, enabled, scope }, cwd);
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
  const row = value as { servers?: unknown; errors?: unknown; note?: unknown };
  if (!Array.isArray(row.servers)) {
    return undefined;
  }
  return {
    servers: row.servers.filter(isServerStatus),
    errors: Array.isArray(row.errors) ? row.errors.filter(isString) : [],
    ...(typeof row.note === 'string' ? { note: row.note } : {}),
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
