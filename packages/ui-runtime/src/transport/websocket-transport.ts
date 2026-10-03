import { decode, encodeWireMessage, parseHostMessage, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from './host-transport.js';

export interface WebSocketHostTransportOptions {
  url: string;
  reconnect?: boolean;
  maxBackoffMs?: number;
  /** Injectable for tests / non-browser runtimes. */
  WebSocketImpl?: typeof WebSocket;
}

const DEFAULT_MAX_BACKOFF_MS = 8_000;

/** Talks to the NestJS host over a native WebSocket (no client library needed). */
export class WebSocketHostTransport extends BaseHostTransport {
  readonly kind = 'websocket' as const;

  private socket: WebSocket | undefined;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Messages the user sent before the socket was open. */
  private readonly queue: ClientToHostMessage[] = [];

  constructor(private readonly options: WebSocketHostTransportOptions) {
    super();
  }

  connect(): void {
    this.disposed = false;
    this.open();
  }

  send(message: ClientToHostMessage): void {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(encodeWireMessage(message));
      return;
    }
    this.queue.push(message);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.emitStatus('closed');
  }

  private open(): void {
    const Impl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) {
      this.emitStatus('error', 'WebSocket is not available in this runtime.');
      return;
    }
    this.emitStatus('connecting', this.options.url);
    const socket = new Impl(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.emitStatus('open');
      const pending = this.queue.splice(0, this.queue.length);
      for (const message of pending) {
        socket.send(encodeWireMessage(message));
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      const message = parseHostMessage(decode(event.data));
      if (message) {
        this.emitMessage(message);
      }
    };

    socket.onerror = () => {
      this.emitStatus('error', `Cannot reach the Morse server at ${this.options.url}.`);
    };

    socket.onclose = () => {
      this.socket = undefined;
      if (this.disposed) {
        this.emitStatus('closed');
        return;
      }
      this.emitStatus('closed', 'Connection lost — retrying…');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.options.reconnect === false || this.timer !== undefined) {
      return;
    }
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const delay = Math.min(max, 500 * 2 ** this.attempts);
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) {
        this.open();
      }
    }, delay);
    // `unref` exists on Node timers only; browsers return a number.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
