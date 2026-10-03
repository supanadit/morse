import { DEFAULT_WS_PATH } from '@morse/protocol';
import { hasVsCodeApi, VsCodeHostTransport } from './vscode-transport.js';
import { WebSocketHostTransport } from './websocket-transport.js';
import { MemoryHostTransport } from './memory-transport.js';
import type { HostTransport } from './host-transport.js';

export interface ResolveTransportOptions {
  /** Defaults to `location.href` in a browser. */
  href?: string;
  websocketPath?: string;
  /** Force the in-memory mock host (`?mock=1`). */
  forceMock?: boolean;
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Picks the transport for the current runtime:
 * 1. inside a VS Code webview -> postMessage bridge
 * 2. `?mock=1` -> in-memory mock host
 * 3. `?server=ws://host:port` -> that host
 * 4. otherwise -> WebSocket on the same origin (`/ws`)
 *
 * One frontend build therefore works in both hosts.
 */
export function resolveTransport(options: ResolveTransportOptions = {}): HostTransport {
  // `hasVsCodeApi()` and not `acquireVsCodeApi()`: the API may only be acquired
  // once, and the transport constructor does that.
  if (hasVsCodeApi()) {
    return new VsCodeHostTransport();
  }

  const href =
    options.href ?? (typeof location !== 'undefined' ? location.href : 'http://localhost/');
  const url = new URL(href, 'http://localhost/');

  if (options.forceMock === true || url.searchParams.get('mock') === '1') {
    return new MemoryHostTransport();
  }

  const explicit = url.searchParams.get('server');
  if (explicit) {
    return new WebSocketHostTransport({ url: explicit, WebSocketImpl: options.WebSocketImpl });
  }

  const secure = url.protocol === 'https:';
  const path = options.websocketPath ?? DEFAULT_WS_PATH;
  return new WebSocketHostTransport({
    url: `${secure ? 'wss' : 'ws'}://${url.host}${path}`,
    WebSocketImpl: options.WebSocketImpl,
  });
}
