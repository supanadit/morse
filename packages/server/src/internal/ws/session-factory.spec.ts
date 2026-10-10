import { describe, expect, it } from 'vitest';
import { isLoopback } from './session-factory.service.js';

/**
 * The gate on `updateHost`. A `--lan` Morse serves an unauthenticated UI, so an
 * address this function lets through is an address that may run `npm install -g`
 * on the host. Every case below is a real spelling a socket can hand over.
 */
describe('isLoopback', () => {
  it('accepts the loopback spellings a socket actually uses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.0.0.5')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    // A dual-stack listener maps IPv4 callers into IPv6.
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
  });

  it('refuses a LAN or public address', () => {
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('::ffff:192.168.1.20')).toBe(false);
    expect(isLoopback('fe80::1')).toBe(false);
    expect(isLoopback('8.8.8.8')).toBe(false);
  });

  it('refuses an address it cannot see, rather than guessing', () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback('')).toBe(false);
  });
});
