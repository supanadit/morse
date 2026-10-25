/**
 * The wire contract: the two message unions, their runtime type lists, and the
 * encode/decode helpers both hosts and every frontend share.
 *
 * The messages themselves live in `./wire/`, split by direction. This file holds
 * the helpers that need both, so a caller keeps importing one path.
 */

import type { ClientToHostMessage } from './wire/client.js';
import type { HostToClientMessage } from './wire/host.js';

export * from './wire/host.js';
export * from './wire/client.js';

export type WireMessage = HostToClientMessage | ClientToHostMessage;

export const HOST_MESSAGE_TYPES = [
  'host/ready',
  'session/state',
  'project/list',
  'session/activity',
  'transcript/append',
  'transcript/update',
  'transcript/delta',
  'transcript/replace',
  'transcript/prepend',
  'session/list',
  'mcp/changed',
  'interaction/request',
  'interaction/dismiss',
  'notice',
  'context/selection',
  'context/selectionLive',
  'composer/seed',
  'host/command/result',
  'error',
  'terminal/output',
  'terminal/exit',
] as const;

export const CLIENT_MESSAGE_TYPES = [
  'client/ready',
  'chat/prompt',
  'chat/edit',
  'chat/fork',
  'chat/abort',
  'session/new',
  'session/load',
  'session/activate',
  'session/close',
  'session/delete',
  'session/compact',
  'history/load',
  'session/list',
  'commands/refresh',
  'models/refresh',
  'modes/refresh',
  'project/list',
  'project/open',
  'engine/set',
  'mode/set',
  'model/set',
  'thinking/set',
  'interaction/respond',
  'host/command',
  'terminal/open',
  'terminal/input',
  'terminal/resize',
  'terminal/close',
] as const;

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify(message);
}

export function isHostToClientMessage(value: unknown): value is HostToClientMessage {
  return hasKnownType(value, HOST_MESSAGE_TYPES);
}

export function isClientToHostMessage(value: unknown): value is ClientToHostMessage {
  return hasKnownType(value, CLIENT_MESSAGE_TYPES);
}

/** Accepts a JSON string or an already parsed object; returns undefined when invalid. */
export function parseHostMessage(raw: unknown): HostToClientMessage | undefined {
  return parseFrame(raw, isHostToClientMessage);
}

export function parseClientMessage(raw: unknown): ClientToHostMessage | undefined {
  return parseFrame(raw, isClientToHostMessage);
}

/**
 * One inbound frame after transport decoding: either the JSON value a frame
 * carried, or nothing when the bytes were not valid JSON. It is deliberately not
 * `unknown`: every caller here hands the result straight to a type guard
 * (`parseClientMessage` / `parseHostMessage`), so the only two states that reach
 * them are "a value to inspect" and "nothing to inspect", and naming that says
 * so at the boundary instead of pushing an unparsed `unknown` outward.
 */
export interface DecodedFrameOk {
  ok: true;
  value: unknown;
}

export interface DecodedFrameFailed {
  ok: false;
}

export type DecodedFrame = DecodedFrameOk | DecodedFrameFailed;

/**
 * Transport-agnostic decode: WebSocket frames may arrive as Buffer/Uint8Array,
 * the VS Code webview passes objects, tests pass strings. The result is a
 * discriminated `DecodedFrame`, so a malformed frame is a value callers can see
 * rather than `undefined` smuggled through an `unknown`.
 */
export function decode(raw: unknown): DecodedFrame {
  if (typeof raw === 'string') {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }
  if (raw instanceof Uint8Array) {
    return decode(new TextDecoder().decode(raw));
  }
  if (raw instanceof ArrayBuffer) {
    return decode(new TextDecoder().decode(new Uint8Array(raw)));
  }
  return { ok: true, value: raw };
}

/**
 * The single frame helper the wire entry points share: decode, then hand the
 * value to a type guard. A frame that decodes to something the guard rejects
 * (or that never decoded) is `undefined`, which is how a bad frame is ignored.
 */
function parseFrame<T>(
  raw: unknown,
  guard: (value: unknown) => value is T,
): T | undefined {
  const frame = decode(raw);
  return frame.ok && guard(frame.value) ? frame.value : undefined;
}

function hasKnownType(value: unknown, allowed: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && allowed.includes(type);
}
