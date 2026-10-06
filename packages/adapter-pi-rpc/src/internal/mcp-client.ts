import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cleanSpawnEnv } from './spawn-env.js';

/**
 * A minimal MCP client for the Inspector.
 *
 * Deliberately hand-written (like the pi RPC client): Morse needs a *connect,
 * initialize, list* probe, not a full SDK, and the two transports in the spec
 * are small enough to own. It speaks the 2025-06-18 lifecycle — `initialize`
 * then `notifications/initialized` — over stdio (newline-delimited JSON-RPC) or
 * Streamable HTTP (POST, JSON or SSE, `Mcp-Session-Id`).
 *
 * It is a *client* only: sampling, elicitation and notifications from the
 * server are ignored. That is the whole point of an inspector probe.
 */

/** What Morse advertises; the server answers with the version it speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const DEFAULT_TIMEOUT_MS = 12_000;
const STDIO_EXIT_GRACE_MS = 600;
const MAX_LOG_CHARS = 8_000;

/** A server to probe: a stdio command, or an HTTP endpoint. */
export interface McpServerSpec {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolSummary {
  name: string;
  title?: string;
  description?: string;
  /** The tool's JSON Schema, passed through for a detail view. */
  inputSchema?: unknown;
}

export interface McpResourceSummary {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateSummary {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgumentSummary {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptSummary {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgumentSummary[];
}

/** Only the capabilities the probe reports; the rest are noise for a card. */
export interface McpServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
  completions?: boolean;
}

/**
 * Why a probe failed, as a class a frontend can branch on rather than scrape
 * prose: auth needs a sign-in, unreachable a wrong command/URL, and so on.
 */
export interface McpInspectionError {
  kind: 'auth' | 'unreachable' | 'timeout' | 'protocol' | 'spawn' | 'unknown';
  message: string;
  status?: number;
  /** OAuth protected-resource metadata URL from `WWW-Authenticate`, when present. */
  authUrl?: string;
}

export interface McpInspection {
  ok: boolean;
  serverInfo?: { name: string; title?: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  capabilities?: McpServerCapabilities;
  tools: McpToolSummary[];
  resources: McpResourceSummary[];
  resourceTemplates: McpResourceTemplateSummary[];
  prompts: McpPromptSummary[];
  /** A stdio server's stderr, capped, so a crash has something to read. */
  logs?: string[];
  error?: McpInspectionError;
  durationMs: number;
}

export interface McpInspectOptions {
  /** Directory a stdio server is spawned in (the session's workspace). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  clientVersion?: string;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** The server returned a JSON-RPC error. */
export class McpProtocolError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

/** The server did not answer in time. */
export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTimeoutError';
  }
}

/** The server refused the connection and wants a sign-in. */
export class McpAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly authUrl?: string,
  ) {
    super(message);
    this.name = 'McpAuthError';
  }
}

/** The server could not be started or reached. */
export class McpUnreachableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'McpUnreachableError';
  }
}

/** The process could not be spawned at all (ENOENT, EACCES). */
export class McpSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSpawnError';
  }
}

/** Shared id/timer bookkeeping; each transport only supplies framing. */
abstract class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >();

  protected abstract write(payload: unknown): void;
  protected abstract teardown(): Promise<void>;

  /** The transport learned the negotiated version; HTTP sends it as a header. */
  adoptProtocolVersion(_version: string): void {}

  /** stderr a stdio server wrote; the HTTP transport has none. */
  logs(): string[] {
    return [];
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(`The server did not answer "${method}" within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    try {
      this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    } catch {
      // A notification has no reply to lose; a dead pipe is reported by the exit handler.
    }
  }

  protected onMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const message = raw as JsonRpcResponse;
    if (message.id === undefined || message.id === null) {
      return;
    }
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.error !== undefined) {
      pending.reject(
        new McpProtocolError(message.error.message ?? 'The server returned an error.', message.error),
      );
      return;
    }
    pending.resolve(message.result);
  }

  protected failAll(error: unknown): void {
    for (const [id, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  async close(): Promise<void> {
    await this.teardown().catch(() => undefined);
  }
}

/** stdio: spawn the server, frame JSON-RPC on newline-delimited stdout. */
class StdioConnection extends JsonRpcConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private closing = false;
  private readonly captured: string[] = [];
  private capturedChars = 0;

  constructor(spec: McpServerSpec, options: McpInspectOptions) {
    super();
    if (!spec.command) {
      throw new McpSpawnError('A stdio server needs a command.');
    }
    this.child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd ?? options.cwd,
      env: { ...cleanSpawnEnv(options.env), ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => this.capture(chunk));
    this.child.on('error', (error: Error) => {
      this.failAll(new McpSpawnError(`Could not start "${spec.command}": ${error.message}`));
    });
    this.child.on('exit', (code) => {
      if (!this.closing) {
        this.failAll(new McpUnreachableError(`The server exited (code=${code ?? 'null'}).`));
      }
    });
  }

  override logs(): string[] {
    return [...this.captured];
  }

  protected write(payload: unknown): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  protected async teardown(): Promise<void> {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.killed) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
    });
    // The documented orderly shutdown: close stdin, let pi's server dispose.
    this.child.stdin.end();
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STDIO_EXIT_GRACE_MS)),
    ]);
    if (!graceful) {
      this.child.kill();
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.onLine(line);
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // stdout is reserved for protocol messages; anything else is a server bug
      // worth showing rather than crashing on.
      this.capture(`[morse] unreadable line from the server: ${line}\n`);
      return;
    }
    this.onMessage(parsed);
  }

  private capture(text: string): void {
    if (this.capturedChars >= MAX_LOG_CHARS) {
      return;
    }
    const remaining = MAX_LOG_CHARS - this.capturedChars;
    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    this.captured.push(slice);
    this.capturedChars += slice.length;
  }
}

/** Streamable HTTP: each request is one POST; the answer is JSON or an SSE stream. */
class HttpConnection extends JsonRpcConnection {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;

  constructor(
    private readonly spec: McpServerSpec,
    _options: McpInspectOptions,
  ) {
    super();
    if (!spec.url) {
      throw new McpUnreachableError('An HTTP server needs a URL.');
    }
  }

  override adoptProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  protected write(payload: unknown): void {
    void this.post(payload);
  }

  protected async teardown(): Promise<void> {
    if (this.sessionId === undefined) {
      return;
    }
    const session = this.sessionId;
    this.sessionId = undefined;
    try {
      await fetch(this.spec.url!, { method: 'DELETE', headers: this.headers(session) });
    } catch {
      // A server that does not allow termination answers 405; either way the
      // probe is over.
    }
  }

  private headers(session = this.sessionId): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.spec.headers ?? {}),
    };
    if (session !== undefined) {
      headers['mcp-session-id'] = session;
    }
    if (this.protocolVersion !== undefined) {
      headers['mcp-protocol-version'] = this.protocolVersion;
    }
    return headers;
  }

  private async post(payload: unknown): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.spec.url!, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
    } catch (error: unknown) {
      this.failAll(new McpUnreachableError(describeNetworkError(error)));
      return;
    }
    const session = response.headers.get('mcp-session-id');
    if (session !== null) {
      this.sessionId = session;
    }
    if (response.status === 401 || response.status === 403) {
      this.failAll(
        new McpAuthError(
          'The server requires authentication.',
          response.status,
          authUrlFrom(response.headers.get('www-authenticate')),
        ),
      );
      return;
    }
    if (response.status === 202 || response.status === 204) {
      return;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.failAll(
        new McpUnreachableError(
          detail.trim().length > 0 ? detail.trim().slice(0, 400) : `The server answered HTTP ${response.status}.`,
          response.status,
        ),
      );
      return;
    }
    const contentType = response.headers.get('content-type') ?? '';
    try {
      if (contentType.includes('text/event-stream')) {
        await this.readSse(response);
      } else {
        const text = await response.text();
        if (text.trim().length > 0) {
          this.onMessage(JSON.parse(text));
        }
      }
    } catch (error: unknown) {
      this.failAll(new McpProtocolError(describeError(error)));
    }
  }

  private async readSse(response: Response): Promise<void> {
    const body = response.body;
    if (body === null) {
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        this.onSseEvent(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim().length > 0) {
      this.onSseEvent(buffer);
    }
  }

  private onSseEvent(event: string): void {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.trim().length === 0) {
      return;
    }
    try {
      this.onMessage(JSON.parse(data));
    } catch {
      // A keep-alive or comment frame is not a message.
    }
  }
}

/**
 * Connect to one server, run the lifecycle, list what it offers, disconnect.
 * Every failure is reported as data (`error.kind`), never thrown, so a host
 * command always has something to render.
 */
export class McpInspector {
  constructor(private readonly options: { clientVersion?: string; timeoutMs?: number } = {}) {}

  async inspect(spec: McpServerSpec, options: McpInspectOptions): Promise<McpInspection> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const empty = { ok: false as const, tools: [], resources: [], resourceTemplates: [], prompts: [] };
    let connection: JsonRpcConnection;
    try {
      connection =
        spec.type === 'http'
          ? new HttpConnection(spec, options)
          : new StdioConnection(spec, options);
    } catch (error: unknown) {
      return { ...empty, error: classify(error), durationMs: Date.now() - started };
    }
    try {
      const initialized = asRecord(
        await connection.request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { roots: { listChanged: false } },
            clientInfo: { name: 'morse', version: options.clientVersion ?? '0.0.0' },
          },
          timeoutMs,
        ),
      );
      const protocolVersion = asString(initialized['protocolVersion']) ?? MCP_PROTOCOL_VERSION;
      connection.adoptProtocolVersion(protocolVersion);
      connection.notify('notifications/initialized');

      const capabilities = toCapabilities(asRecord(initialized['capabilities']));
      const serverInfo = toServerInfo(asRecord(initialized['serverInfo']));
      const instructions = asString(initialized['instructions']);
      const logs = connection.logs();

      const result: McpInspection = {
        ok: true,
        ...(serverInfo ? { serverInfo } : {}),
        protocolVersion,
        ...(instructions ? { instructions } : {}),
        capabilities,
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        ...(logs.length > 0 ? { logs } : {}),
        durationMs: 0,
      };

      // Each list is asked for only when the server advertised it; a server that
      // lies gets a protocol error rather than a wall of guesses.
      if (capabilities.tools) {
        result.tools = toTools(await this.list(connection, 'tools/list', timeoutMs));
      }
      if (capabilities.resources) {
        result.resources = toResources(await this.list(connection, 'resources/list', timeoutMs));
        result.resourceTemplates = toResourceTemplates(
          await this.list(connection, 'resources/templates/list', timeoutMs),
        );
      }
      if (capabilities.prompts) {
        result.prompts = toPrompts(await this.list(connection, 'prompts/list', timeoutMs));
      }
      result.durationMs = Date.now() - started;
      return result;
    } catch (error: unknown) {
      return {
        ...empty,
        ...(connection.logs().length > 0 ? { logs: connection.logs() } : {}),
        error: classify(error),
        durationMs: Date.now() - started,
      };
    } finally {
      await connection.close();
    }
  }

  private async list(
    connection: JsonRpcConnection,
    method: string,
    timeoutMs: number,
  ): Promise<unknown[]> {
    const result = asRecord(await connection.request(method, {}, timeoutMs));
    const key = method.startsWith('tools')
      ? 'tools'
      : method.startsWith('prompts')
        ? 'prompts'
        : method.startsWith('resources/templates')
          ? 'resourceTemplates'
          : 'resources';
    const values = result[key];
    return Array.isArray(values) ? values : [];
  }
}

/**
 * Rebuild a server spec from a wire payload, so both hosts parse the panel's
 * `mcpInspect` arguments identically. `type` infers `http` from a URL when the
 * caller omitted it, exactly like the add form does.
 */
export function parseMcpServerSpec(raw: unknown): McpServerSpec {
  const args = asRecord(raw);
  const isHttp = args['type'] === 'http' || (args['url'] !== undefined && args['command'] === undefined);
  const spec: McpServerSpec = { type: isHttp ? 'http' : 'stdio' };
  const command = asString(args['command']);
  if (command !== undefined) {
    spec.command = command;
  }
  const url = asString(args['url']);
  if (url !== undefined) {
    spec.url = url;
  }
  const cwd = asString(args['cwd']);
  if (cwd !== undefined) {
    spec.cwd = cwd;
  }
  if (Array.isArray(args['args'])) {
    spec.args = args['args'].filter((value): value is string => typeof value === 'string');
  }
  const env = stringRecord(args['env']);
  if (env !== undefined) {
    spec.env = env;
  }
  const headers = stringRecord(args['headers']);
  if (headers !== undefined) {
    spec.headers = headers;
  }
  return spec;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Turn any probe failure into the class a frontend branches on. */
export function classify(error: unknown): McpInspectionError {
  if (error instanceof McpAuthError) {
    return {
      kind: 'auth',
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.authUrl !== undefined ? { authUrl: error.authUrl } : {}),
    };
  }
  if (error instanceof McpTimeoutError) {
    return { kind: 'timeout', message: error.message };
  }
  if (error instanceof McpProtocolError) {
    return { kind: 'protocol', message: error.message };
  }
  if (error instanceof McpSpawnError) {
    return { kind: 'spawn', message: error.message };
  }
  if (error instanceof McpUnreachableError) {
    return {
      kind: 'unreachable',
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  return { kind: 'unknown', message: describeError(error) };
}

function toCapabilities(raw: Record<string, unknown>): McpServerCapabilities {
  return {
    ...(raw['tools'] !== undefined ? { tools: true } : {}),
    ...(raw['resources'] !== undefined ? { resources: true } : {}),
    ...(raw['prompts'] !== undefined ? { prompts: true } : {}),
    ...(raw['logging'] !== undefined ? { logging: true } : {}),
    ...(raw['completions'] !== undefined ? { completions: true } : {}),
  };
}

function toServerInfo(raw: Record<string, unknown>): McpInspection['serverInfo'] {
  const name = asString(raw['name']);
  if (name === undefined) {
    return undefined;
  }
  const title = asString(raw['title']);
  const version = asString(raw['version']);
  return { name, ...(title ? { title } : {}), ...(version ? { version } : {}) };
}

function toTools(values: unknown[]): McpToolSummary[] {
  return values
    .map((value): McpToolSummary | undefined => {
      const row = asRecord(value);
      const name = asString(row['name']);
      if (name === undefined) {
        return undefined;
      }
      const title = asString(row['title']);
      const description = asString(row['description']);
      return {
        name,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(row['inputSchema'] !== undefined ? { inputSchema: row['inputSchema'] } : {}),
      };
    })
    .filter((tool): tool is McpToolSummary => tool !== undefined);
}

function toResources(values: unknown[]): McpResourceSummary[] {
  return values
    .map((value): McpResourceSummary | undefined => {
      const row = asRecord(value);
      const uri = asString(row['uri']);
      if (uri === undefined) {
        return undefined;
      }
      return {
        uri,
        ...pick(row, ['name', 'title', 'description', 'mimeType']),
      };
    })
    .filter((resource): resource is McpResourceSummary => resource !== undefined);
}

function toResourceTemplates(values: unknown[]): McpResourceTemplateSummary[] {
  return values
    .map((value): McpResourceTemplateSummary | undefined => {
      const row = asRecord(value);
      const uriTemplate = asString(row['uriTemplate']);
      if (uriTemplate === undefined) {
        return undefined;
      }
      return { uriTemplate, ...pick(row, ['name', 'title', 'description', 'mimeType']) };
    })
    .filter((template): template is McpResourceTemplateSummary => template !== undefined);
}

function toPrompts(values: unknown[]): McpPromptSummary[] {
  return values
    .map((value): McpPromptSummary | undefined => {
      const row = asRecord(value);
      const name = asString(row['name']);
      if (name === undefined) {
        return undefined;
      }
      const args = Array.isArray(row['arguments'])
        ? row['arguments']
            .map((value): McpPromptArgumentSummary | undefined => {
              const arg = asRecord(value);
              const argName = asString(arg['name']);
              if (argName === undefined) {
                return undefined;
              }
              const description = asString(arg['description']);
              return {
                name: argName,
                ...(description ? { description } : {}),
                ...(arg['required'] === true ? { required: true } : {}),
              };
            })
            .filter((arg): arg is McpPromptArgumentSummary => arg !== undefined)
        : [];
      return { name, ...pick(row, ['title', 'description']), ...(args.length > 0 ? { arguments: args } : {}) };
    })
    .filter((prompt): prompt is McpPromptSummary => prompt !== undefined);
}

function pick<T extends string>(row: Record<string, unknown>, keys: T[]): { [K in T]?: string } {
  const out: { [K in T]?: string } = {};
  for (const key of keys) {
    const value = asString(row[key]);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** The `resource_metadata` URL out of a `WWW-Authenticate` challenge. */
function authUrlFrom(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  const match = /resource_metadata="([^"]+)"/i.exec(header);
  return match?.[1];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function describeNetworkError(error: unknown): string {
  const base = describeError(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? (cause as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' ? `${base} (${code})` : base;
}
