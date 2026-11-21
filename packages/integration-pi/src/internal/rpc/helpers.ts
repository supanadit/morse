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

import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '@morse/system';

export { asArray, asNumber, asRecord, asString };
export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
