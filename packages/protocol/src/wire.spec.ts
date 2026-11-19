import { describe, expect, it } from 'vitest';

import type { ClientToHostMessage, HostToClientMessage } from './wire.js';
import {
  CLIENT_MESSAGE_TYPES,
  HOST_MESSAGE_TYPES,
  isClientToHostMessage,
} from './wire.js';

/**
 * Compiles only when `T` is `never`.
 *
 * A message type its union declares but its runtime list forgets never reaches a
 * host: `parseClientMessage` answers `undefined` and the frame is dropped without
 * a word, so the button that sends it simply appears to do nothing. This turns
 * that omission into a type error instead.
 */
function expectNothingMissing<T extends never>(...missing: T[]): void {
  // Nothing happens at runtime: the call compiles only when no type is missing.
  void missing;
}

describe('wire message lists', () => {
  it('lists every message type each direction declares', () => {
    expectNothingMissing<
      Exclude<ClientToHostMessage['type'], (typeof CLIENT_MESSAGE_TYPES)[number]>
    >();
    expectNothingMissing<
      Exclude<HostToClientMessage['type'], (typeof HOST_MESSAGE_TYPES)[number]>
    >();
  });

  it('accepts a thread delete and refuses a type nobody declared', () => {
    expect(
      isClientToHostMessage({ type: 'bot/threadDelete', payload: { id: 'thread-loom-sigil' } }),
    ).toBe(true);
    expect(isClientToHostMessage({ type: 'bot/threadNope', payload: {} })).toBe(false);
  });
});
