import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import type {
  ConfigIssue,
  ConfigMutation,
  McpConfigScope,
  McpInspectionResult,
  McpServerInput,
  McpServerStatus,
  McpStatus,
  McpMutation,
  ProjectTrustResult,
} from '@morse/protocol';
import { MorseService } from '../host/morse.service';
import { asConfigIssues, asConfigMutation } from './config-issue';
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
 * A probe dials every enabled server, so it is neither instant nor free: a
 * directory is probed at most once a minute even when a refresh is forced. The
 * fast list moves when the files move; a connection does not.
 */
const PROBE_TTL_MS = 60_000;
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
  /**
   * Probing is its own state: it is a slow, optional second read, and the panel's
   * Refresh must not be disabled for the whole time servers dial. Keyed like the
   * status, so a hint can follow the directory and the engine.
   */
  private readonly probing = signal<Record<string, boolean>>({});
  private readonly fetchedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<McpStatus | undefined>>();
  /**
   * The probe's own track. A probe is a second, slower read of the same
   * directory: sharing the fast read's slot would let either answer for the
   * other, and a refresh must never swallow the live state the panel asked for.
   */
  private readonly probeInFlight = new Map<string, Promise<McpStatus | undefined>>();
  /** When a directory's probe last answered, so the TTL can skip the next one. */
  private readonly probedAt = new Map<string, number>();
  /**
   * How many fast reads a key has started. A probe captures this number and
   * drops its answer if a newer fast read began in the meantime: an older probe
   * must never overwrite a fresher read.
   */
  private readonly generations = new Map<string, number>();

  /** Only a host that can manage some engine's MCP servers advertises this. */
  readonly enabled = computed(() => this.morse.capabilities()?.mcp === true);

  /**
   * Whether this host answers `configFix`. A host without it (VS Code) refuses
   * the command, so the panel hides Fix and says a hand edit is needed instead
   * of offering an action that can only fail.
   */
  readonly canFix = computed(() => this.morse.capabilities()?.configFix === true);

  /**
   * The engine the MCP modal is about: the draft's choice, or the session's
   * owner. Engines keep separate configs (`mcp.json` vs `opencode.json`), so it
   * rides every command and the cache is keyed by it — a pi session and an
   * OpenCode session in the same directory see different server lists.
   */
  readonly engine = computed(() => this.morse.engine());

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
      // Both reads are tracked: switching the engine re-runs this, so the modal
      // follows the dropdown immediately instead of showing the previous
      // engine's servers.
      const target = this.cwd();
      const engine = this.engine();
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
      if (Date.now() - (this.fetchedAt.get(this.keyOf(dir)) ?? 0) < FOCUS_MIN_INTERVAL_MS) {
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
    return this.byCwd()[this.keyOf(cwd)];
  }

  isLoading(cwd: string): boolean {
    return this.loadingByCwd()[this.keyOf(cwd)] === true;
  }

  /** The dot's colour: healthy, something to look at, broken, or nothing configured. */
  overall(cwd: string): McpOverall {
    const status = this.status(cwd);
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
    return (this.status(cwd)?.servers ?? []).filter(
      (server) => server.enabled && server.state === 'connected',
    ).length;
  }

  /**
   * The host saw an `mcp.json` move on disk: drop that directory's cache (or
   * every directory's, for the user-level file) and re-read what is in front.
   */
  private onExternalChange(cwd: string): void {
    const prefix = `${this.engine() ?? ''}|`;
    if (cwd.length === 0) {
      for (const key of [...this.fetchedAt.keys()]) {
        if (key.startsWith(prefix)) {
          this.fetchedAt.delete(key);
        }
      }
      // A live probe is as stale as the list it came with: whoever edited the
      // file may have changed what connects, so the next refresh must probe.
      for (const key of [...this.probedAt.keys()]) {
        if (key.startsWith(prefix)) {
          this.probedAt.delete(key);
        }
      }
    } else {
      this.fetchedAt.delete(this.keyOf(cwd));
      this.probedAt.delete(this.keyOf(cwd));
    }
    const current = this.cwd();
    if (cwd.length === 0 || cwd === current) {
      void this.refresh(current, true);
    }
  }

  /**
   * Fetch a directory's status, reusing a recent answer unless `force` is set.
   * Resolves `undefined` when the host did not answer (an older host, a timeout).
   *
   * The fast read answers from the config files alone so the panel draws at
   * once; a probe then asks the engine to connect each enabled server and
   * replaces the answer when it arrives. The probe is not awaited: a panel that
   * waited for a dial would look broken on a slow server. Only a read that
   * actually reached the host probes — a cache hit would otherwise turn every
   * tab switch, focus and file-watch push into a full dial.
   */
  async refresh(cwd: string, force = false): Promise<McpStatus | undefined> {
    const { status, fetched } = await this.load(cwd, force);
    if (fetched && status !== undefined) {
      void this.probe(cwd);
    }
    return status;
  }

  /**
   * Ask the engine to connect every enabled server and report live state.
   *
   * A probe is expensive, so it is skipped when this directory answered one
   * within `PROBE_TTL_MS`, while one is already in flight, and on an engine that
   * ignores `probe` (OpenCode reports configured state only, so the fast read
   * already is the whole answer).
   */
  probe(cwd: string): Promise<McpStatus | undefined> {
    const existing = this.probeInFlight.get(cwd);
    if (existing) {
      return existing;
    }
    if (this.engine() === 'opencode') {
      return Promise.resolve(undefined);
    }
    const key = this.keyOf(cwd);
    if (Date.now() - (this.probedAt.get(key) ?? 0) < PROBE_TTL_MS) {
      return Promise.resolve(undefined);
    }
    const promise = this.fetch(cwd, true);
    this.probeInFlight.set(cwd, promise);
    return promise.finally(() => {
      this.probeInFlight.delete(cwd);
    });
  }

  /** Whether a live probe is in flight for this directory (the hint, not the spinner). */
  isProbing(cwd: string): boolean {
    return this.probing()[this.keyOf(cwd)] === true;
  }

  /**
   * The fast (or cached) read: one round trip per directory at a time, and
   * `fetched` says whether the host was actually asked (not a TTL cache hit).
   */
  private async load(
    cwd: string,
    force: boolean,
  ): Promise<{ status: McpStatus | undefined; fetched: boolean }> {
    const existing = this.inFlight.get(cwd);
    if (existing) {
      return { status: await existing, fetched: true };
    }
    // The signals and timestamps are keyed by engine too; reading them by bare
    // `cwd` made every refresh look like a cache miss and re-asked the host.
    const key = this.keyOf(cwd);
    const last = this.fetchedAt.get(key) ?? 0;
    if (!force && this.byCwd()[key] && Date.now() - last < STATUS_TTL_MS) {
      return { status: this.byCwd()[key], fetched: false };
    }
    const promise = this.fetch(cwd);
    this.inFlight.set(cwd, promise);
    return {
      status: await promise.finally(() => {
        this.inFlight.delete(cwd);
      }),
      fetched: true,
    };
  }

  private async fetch(cwd: string, probe = false): Promise<McpStatus | undefined> {
    const key = this.keyOf(cwd);
    // A fast read moves the key's generation; a probe only remembers it, so a
    // probe that started before a newer read cannot claim to be newer than it.
    const generation = probe ? (this.generations.get(key) ?? 0) : this.nextGeneration(key);
    if (probe) {
      this.setProbing(key, true);
    } else {
      this.setLoading(cwd, true);
    }
    try {
      const data = await this.morse.requestHostCommand(
        'mcpStatus',
        {
          ...(cwd.length > 0 ? { cwd } : { scope: 'global' }),
          ...(this.engine() === undefined ? {} : { engine: this.engine() }),
          ...(probe ? { probe: true } : {}),
        },
        STATUS_TIMEOUT_MS,
      );
      const status = asMcpStatus(data);
      if (status && (!probe || (this.generations.get(key) ?? 0) === generation)) {
        this.byCwd.update((map) => ({ ...map, [key]: status }));
        this.fetchedAt.set(key, Date.now());
        if (probe) {
          this.probedAt.set(key, Date.now());
        }
      }
      return status;
    } finally {
      if (probe) {
        this.setProbing(key, false);
      } else {
        this.setLoading(cwd, false);
      }
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
    const data = await this.morse.requestHostCommand(
      'trustProject',
      {
        cwd,
        ...(this.engine() === undefined ? {} : { engine: this.engine() }),
      },
      MUTATION_TIMEOUT_MS,
    );
    const result = asTrustResult(data);
    if (result.ok) {
      await this.refresh(cwd, true);
    }
    return result;
  }

  /**
   * Rewrite the file one config issue names, so a later write can land. The host
   * resolves the engine from `engine` and validates the path against that
   * engine's own config paths; an older host answers `undefined`, which this
   * reads as a refusal instead of a success it cannot prove.
   */
  async fix(cwd: string, issue: ConfigIssue): Promise<ConfigMutation> {
    const data = await this.morse.requestHostCommand(
      'configFix',
      {
        fileId: issue.fileId,
        path: issue.file,
        scope: issue.scope,
        ...(cwd.length > 0 ? { cwd } : {}),
        ...(this.engine() === undefined ? {} : { engine: this.engine() }),
      },
      MUTATION_TIMEOUT_MS,
    );
    const result = asConfigMutation(data);
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
    // The mutation lands in the config of the engine the modal is showing.
    const data = await this.morse.requestHostCommand(
      command,
      {
        ...args,
        ...(this.engine() === undefined ? {} : { engine: this.engine() }),
      },
      MUTATION_TIMEOUT_MS,
    );
    const result = asMcpMutation(data);
    if (result.ok) {
      // The files just moved, so the live state a probe reported is stale: the
      // next refresh must dial again instead of waiting out the probe TTL.
      this.probedAt.delete(this.keyOf(cwd));
      await this.refresh(cwd, true);
    }
    return result;
  }

  /** Cache key: the engine's config decides the servers as much as the directory. */
  private keyOf(cwd: string): string {
    return `${this.engine() ?? ''}|${cwd}`;
  }

  private setLoading(cwd: string, loading: boolean): void {
    this.loadingByCwd.update((map) => ({ ...map, [this.keyOf(cwd)]: loading }));
  }

  private setProbing(key: string, probing: boolean): void {
    this.probing.update((map) => ({ ...map, [key]: probing }));
  }

  /** The key's next fast-read generation; every started fast read moves it. */
  private nextGeneration(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }
}

function asMcpStatus(value: unknown): McpStatus | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const row = value as {
    servers?: unknown;
    errors?: unknown;
    note?: unknown;
    trusted?: unknown;
    issues?: unknown;
  };
  if (!Array.isArray(row.servers)) {
    return undefined;
  }
  const issues = asConfigIssues(row.issues);
  return {
    servers: row.servers.filter(isServerStatus),
    errors: Array.isArray(row.errors) ? row.errors.filter(isString) : [],
    ...(typeof row.note === 'string' ? { note: row.note } : {}),
    ...(row.trusted === true ? { trusted: true } : row.trusted === false ? { trusted: false } : {}),
    ...(issues.length > 0 ? { issues } : {}),
  };
}

/** A row the panel can draw: a name and a state are the two things it renders. */
function isServerStatus(value: unknown): value is McpServerStatus {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as { name?: unknown; state?: unknown };
  return typeof row.name === 'string' && typeof row.state === 'string';
}

function asMcpMutation(value: unknown): McpMutation {
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true) {
    const row = value as { path?: unknown; scope?: unknown; override?: unknown; issues?: unknown };
    const issues = asConfigIssues(row.issues);
    return {
      ok: true,
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
      ...(row.scope === 'global' || row.scope === 'project' ? { scope: row.scope } : {}),
      ...(row.override === true ? { override: true } : {}),
      ...(issues.length > 0 ? { issues } : {}),
    };
  }
  const row = (typeof value === 'object' && value !== null ? value : undefined) as
    | { message?: unknown; issues?: unknown }
    | undefined;
  const message =
    typeof row?.message === 'string' ? row.message : 'The host did not apply the change.';
  // A refusal keeps its config complaints: the MCP editor names the one Fix
  // action that clears a `normalize` refusal, so dropping them loses the cure.
  return { ok: false, message, issues: asConfigIssues(row?.issues) };
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
