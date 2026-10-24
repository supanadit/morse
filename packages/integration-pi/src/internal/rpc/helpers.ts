/**
 * The record shape every pi frame shares, and the small readers used to walk it
 * without trusting any field.
 */
import type { RpcResponse } from './data.js';
import type { RpcExtensionUiRequest } from './extension-ui.js';

/** A record Morse has no shape for; only its `type` is read, to route it. */
export interface RpcOtherRecord {
  type: string;
}

/** Anything else pi writes on stdout: a session event we may or may not map. */
export type RpcRecord = (RpcResponse | RpcExtensionUiRequest | RpcOtherRecord) &
  Record<string, unknown>;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
