import { OPENCODE_API_PREFIX, type OpenCodeConnection } from './connection.js';

/**
 * The thin HTTP client every OpenCode module shares.
 *
 * One method per shape the installed server actually answers with: a `{ data }`
 * envelope, a `{ data, cursor }` page, and a bare `204`. Unwrapping here keeps
 * `agent.ts` about sessions instead of about envelopes, and keeps a version
 * mismatch (`properties` instead of `data`, a renamed field) in one place.
 *
 * Every call authenticates with the server's Basic password; there is no token
 * cache because OpenCode does not issue one.
 */

/** A cursor-paged response, as the installed server sends it. */
export interface OpenCodePage<T> {
  data: T[];
  cursor?: { previous?: string | null; next?: string | null } | null;
}

/** What a failed request carries: the HTTP status and the server's own message. */
export class OpenCodeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'OpenCodeRequestError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenCodeApi {
  constructor(
    private readonly connection: Pick<OpenCodeConnection, 'baseUrl' | 'password'>,
    /** Per-request timeout; long turns never block a request (prompts return on accept). */
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** One resource under `data`. */
  async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const raw = await this.raw('GET', path, query);
    return (isRecord(raw) && 'data' in raw ? raw['data'] : raw) as T;
  }

  /** A whole page under `data`, with the cursor that continues it. */
  async page<T>(path: string, query?: Record<string, string | undefined>): Promise<OpenCodePage<T>> {
    const body = await this.raw('GET', path, query);
    return readPage<T>(body);
  }

  /** The response body as the server sent it (for endpoints that are not enveloped). */
  async raw(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<unknown> {
    const url = this.url(path, query);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: this.authorization(),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      throw new OpenCodeRequestError(
        0,
        path,
        `OpenCode did not answer ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
      );
    }
    const text = await response.text().catch(() => '');
    const parsed = parseJson(text);
    if (!response.ok) {
      throw new OpenCodeRequestError(
        response.status,
        path,
        describeFailure(method, path, response.status, parsed),
        parsed,
      );
    }
    return parsed;
  }

  /** An enveloped resource; `undefined` when the server answered `204`. */
  async post<T>(
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T | undefined> {
    const raw = await this.raw('POST', path, query, body ?? {});
    if (raw === undefined || raw === null) {
      return undefined;
    }
    return (isRecord(raw) && 'data' in raw ? raw['data'] : raw) as T;
  }

  /** An enveloped page from a POST. */
  async postPage<T>(
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<OpenCodePage<T>> {
    return readPage<T>(await this.raw('POST', path, query, body ?? {}));
  }

  async delete(path: string, query?: Record<string, string | undefined>): Promise<void> {
    await this.raw('DELETE', path, query);
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${this.connection.baseUrl}${OPENCODE_API_PREFIX}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private authorization(): string {
    return `Basic ${Buffer.from(`opencode:${this.connection.password}`, 'utf8').toString('base64')}`;
  }
}

/** `{ data: [...] }` or a bare array → one page. */
function readPage<T>(body: unknown): OpenCodePage<T> {
  if (Array.isArray(body)) {
    return { data: body as T[] };
  }
  if (isRecord(body)) {
    const data = body['data'];
    const cursor = isRecord(body['cursor']) ? (body['cursor'] as OpenCodePage<T>['cursor']) : undefined;
    return { data: Array.isArray(data) ? (data as T[]) : [], ...(cursor === undefined ? {} : { cursor }) };
  }
  return { data: [] };
}

/** The server's error envelope is `{ _tag, message, ... }`; anything else is raw text. */
function describeFailure(method: string, path: string, status: number, body: unknown): string {
  if (isRecord(body)) {
    const tag = typeof body['_tag'] === 'string' ? body['_tag'] : undefined;
    const message = typeof body['message'] === 'string' ? body['message'] : undefined;
    if (message !== undefined) {
      return `${method} ${path} failed (${status}${tag === undefined ? '' : ` ${tag}`}): ${message}`;
    }
  }
  return `${method} ${path} failed with ${status}.`;
}

function parseJson(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
