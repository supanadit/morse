/**
 * Wire protocol version. Bump this (and the frontends) whenever a message shape
 * changes in a breaking way — hosts refuse to talk to a mismatched frontend.
 */
export const PROTOCOL_VERSION = 17;

/** File a frontend build writes next to its index.html so any host can identify it. */
export const FRONTEND_MANIFEST_FILE = 'webview.manifest.json';

/** Default HTTP path the NestJS host exposes its WebSocket endpoint on. */
export const DEFAULT_WS_PATH = '/ws';
