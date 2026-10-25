import type { MorseLogger } from '@morse/system';
import { OPENCODE_API_PREFIX, type OpenCodeConnection } from './connection.js';

/**
 * The engine's one event stream.
 *
 * OpenCode multiplexes every session's events onto a single SSE endpoint
 * (`GET /api/event`), so Morse keeps exactly one subscription per engine and
 * routes each event to the session that owns it by `data.sessionID`. A session
 * therefore never opens its own connection, and a second subscriber of the same
 * session sees the same fragments — both properties the per-session gateway
 * contract relies on.
 *
 * A stream is a network connection, so it dies: a host sleep, a server restart, a
 * killed owned process. The stream reconnects with exponential backoff and tells
 * every open session when it did (`stream.connected`), so an agent can re-read
 * the state it missed. When reconnection keeps failing past a threshold, it
 * reports `stream.fatal` once to every open session; the agent turns that into
 * the `agent/fatal` its host already knows how to show. A later success clears
 * the report, so the next death is reported again.
 *
 * `stream.connected` and `stream.fatal` are synthetic events: they are shaped
 * like the server's own (`type` + `data`) so the event mapping handles one kind
 * of input, and they carry the subscriber's `sessionID` so a per-session mapper
 * can treat them uniformly.
 */

/** One event as the server sends it, normalized. */
export interface OpenCodeEvent {
  /** The server's event type (`session.text.delta`, `project.updated`, …). */
  type: string;
  /**
   * The payload. The installed server puts it under `data`; some versions (and
   * the pre-release SDK) call it `properties`, so both are accepted.
   */
  data: Record<string, unknown>;
  /** When the server created the event, epoch milliseconds. */
  created: number;
}

export type OpenCodeEventListener = (event: OpenCodeEvent) => void;

export interface OpenCodeEventStreamOptions {
  logger: MorseLogger;
  /** First reconnect delay; doubles per consecutive failure. */
  reconnectBaseMs?: number;
  /** Ceiling for the reconnect delay. */
  reconnectMaxMs?: number;
  /** Consecutive failed attempts before a death is reported. */
  fatalAfter?: number;
}

const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_FATAL_AFTER = 3;
/** Bound on the partial-line buffer, so a malformed stream cannot grow forever. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export class OpenCodeEventStream {
  private readonly listeners = new Map<string, Set<OpenCodeEventListener>>();
  private readonly options: Required<Omit<OpenCodeEventStreamOptions, 'logger'>> & {
    logger: MorseLogger;
  };
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private stopped = false;
  private connected = false;
  private failures = 0;
  private deathReported = false;
  /** Increments on every successful connection, so tests can observe reconnects. */
  private connections = 0;
  /** The `data:` lines of the SSE frame being assembled. */
  private frame: string[] = [];

  constructor(
    private readonly connection: Pick<OpenCodeConnection, 'baseUrl' | 'password'>,
    options: OpenCodeEventStreamOptions,
  ) {
    this.options = {
      logger: options.logger,
      reconnectBaseMs: options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs: options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      fatalAfter: options.fatalAfter ?? DEFAULT_FATAL_AFTER,
    };
  }

  /** How many times the stream has connected (the first connection included). */
  get connectionCount(): number {
    return this.connections;
  }

  /**
   * Listens to one session's events, plus that session's stream status. Returns
   * the unsubscribe function and starts the stream on the first subscriber: an
   * engine with no open session pays no connection.
   */
  subscribe(sessionID: string, listener: OpenCodeEventListener): () => void {
    let set = this.listeners.get(sessionID);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionID, set);
    }
    set.add(listener);
    this.start();
    // A subscriber that arrives after the stream is already up (a resumed
    // session, a second agent) still needs the "you are connected" beat: it is
    // what triggers the agent's state refresh and pending-form poll.
    if (this.connected) {
      queueMicrotask(() => {
        if (this.listeners.get(sessionID)?.has(listener) === true) {
          listener({ type: 'stream.connected', data: { sessionID }, created: Date.now() });
        }
      });
    }
    return () => {
      const current = this.listeners.get(sessionID);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(sessionID);
      }
      // The engine owns the stream's lifetime: an idle moment between sessions
      // must not tear down the connection every agent would have to re-establish.
    };
  }

  /** Opens the stream if it is not already running (idempotent). */
  start(): void {
    if (this.loop !== undefined || this.stopped) {
      return;
    }
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal).finally(() => {
      this.loop = undefined;
    });
  }

  /** Stops reading and reconnecting. The server connection is left alone. */
  async close(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  /** The reconnect loop: read until the response ends, then back off and retry. */
  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.readOnce(signal);
        // A stream that ended cleanly is still a stream to re-establish; there is
        // no "finished" for a subscription.
        this.noteDisconnect(undefined, false);
      } catch (error: unknown) {
        if (signal.aborted) {
          return;
        }
        this.noteDisconnect(error, true);
      }
      const delay = Math.min(
        this.options.reconnectBaseMs * 2 ** Math.max(0, this.failures - 1),
        this.options.reconnectMaxMs,
      );
      await sleep(delay, signal);
    }
  }

  /** One connection: parse SSE frames, route each to its session. */
  private async readOnce(signal: AbortSignal): Promise<void> {
    const response = await fetch(`${this.connection.baseUrl}${OPENCODE_API_PREFIX}/event`, {
      headers: {
        authorization: basicAuth(this.connection.password),
        accept: 'text/event-stream',
      },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      // A wrong password will never fix itself: report it as a failure instead of
      // reconnecting forever with credentials the user must change.
      throw new UnauthorizedStream();
    }
    if (!response.ok || response.body === null) {
      throw new Error(`event stream answered ${response.status} ${response.statusText}`);
    }

    this.connections += 1;
    this.connected = true;
    this.failures = 0;
    this.deathReported = false;
    this.broadcastStatus('stream.connected');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        pending += decoder.decode(value, { stream: true });
        if (pending.length > MAX_PENDING_BYTES) {
          throw new Error('the event stream sent no complete frame for too long');
        }
        const frames = pending.split('\n');
        pending = frames.pop() ?? '';
        for (const line of frames) {
          const event = this.consume(line);
          if (event !== undefined) {
            this.dispatch(event);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  /**
   * Folds one SSE line into the current frame.
   *
   * OpenCode sends `data:` lines and `: heartbeat` comments (ignored). A blank
   * line ends a frame; `event:` is ignored because the type lives inside the JSON
   * payload. Multi-line `data:` is joined with newlines, as the SSE spec says.
   */
  private consume(line: string): OpenCodeEvent | undefined {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      const raw = this.frame.join('\n');
      this.frame = [];
      return raw.length === 0 ? undefined : parseEvent(raw);
    }
    if (trimmed.startsWith(':')) {
      return undefined;
    }
    if (trimmed.startsWith('data:')) {
      this.frame.push(trimmed.slice('data:'.length).replace(/^ /, ''));
    }
    // Other SSE fields (`event:`, `id:`, `retry:`) are irrelevant: the payload
    // carries the type and the id, and the server's retry hint is not used.
    return undefined;
  }

  /** Routes one server event to the session it names; unknown shapes are ignored. */
  private dispatch(event: OpenCodeEvent): void {
    const sessionID = sessionIdOf(event);
    if (sessionID === undefined) {
      return;
    }
    const listeners = this.listeners.get(sessionID);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.options.logger.error(`OpenCode event listener failed for ${sessionID}`, error);
      }
    }
  }

  /** Records a failure and tells every open session once it looks like a death. */
  private noteDisconnect(error: unknown, reconnect: boolean): void {
    this.connected = false;
    this.failures += 1;
    if (reconnect) {
      this.options.logger.warn('The OpenCode event stream disconnected; reconnecting', error);
    }
    if (this.failures < this.options.fatalAfter || this.deathReported) {
      return;
    }
    this.deathReported = true;
    const message =
      error instanceof UnauthorizedStream
        ? 'The OpenCode server rejected the event stream password.'
        : 'The OpenCode event stream is unavailable.';
    this.broadcastStatus('stream.fatal', { message });
  }

  /** Sends a synthetic status event to every open session. */
  private broadcastStatus(type: 'stream.connected' | 'stream.fatal', data: Record<string, unknown> = {}): void {
    for (const [sessionID, listeners] of this.listeners) {
      const event: OpenCodeEvent = {
        type,
        data: { ...data, sessionID },
        created: Date.now(),
      };
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error: unknown) {
          this.options.logger.error(`OpenCode stream status listener failed for ${sessionID}`, error);
        }
      }
    }
  }
}

/**
 * The session an event belongs to, when the event is session-scoped.
 *
 * Most events carry `data.sessionID`; `form.created` wraps the form instead
 * (`data.form.sessionID`), so a pending form would otherwise vanish before any
 * session saw it.
 */
function sessionIdOf(event: OpenCodeEvent): string | undefined {
  const value = event.data['sessionID'];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  const form = event.data['form'];
  if (form !== null && typeof form === 'object') {
    const formSession = (form as Record<string, unknown>)['sessionID'];
    return typeof formSession === 'string' && formSession.length > 0 ? formSession : undefined;
  }
  return undefined;
}

/** One JSON frame → an event, or nothing when it is not shaped like one. */
function parseEvent(raw: string): OpenCodeEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const frame = parsed as {
    type?: unknown;
    data?: unknown;
    properties?: unknown;
    created?: unknown;
  };
  if (typeof frame.type !== 'string') {
    return undefined;
  }
  // The installed server names the payload `data`; the pre-release SDK called it
  // `properties`. Accepting both is cheaper than pinning either.
  const payload = frame.data ?? frame.properties;
  return {
    type: frame.type,
    data: payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {},
    created: typeof frame.created === 'number' ? frame.created : Date.now(),
  };
}

class UnauthorizedStream extends Error {
  constructor() {
    super('the event stream refused the password');
    this.name = 'UnauthorizedStream';
  }
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

/** A sleep that the stream's abort can cut short. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
