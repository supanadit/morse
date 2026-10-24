import { describe, expect, it } from 'vitest';
import { TERMINAL_BUFFER_CHARS, trimTail } from './terminal-buffer.js';

describe('trimTail', () => {
  it('leaves a buffer that already fits exactly as it is', () => {
    expect(trimTail('hello\n', 64)).toBe('hello\n');
    expect(trimTail('', 64)).toBe('');
  });

  it('keeps the tail and cuts at a newline, so a replay starts on a fresh line', () => {
    // The cap lands on the newline before `bbbb`; the cut moves past it.
    expect(trimTail('aaa\nbbbb\n', 6)).toBe('bbbb\n');
  });

  it('keeps the raw tail when one line has no newline to cut at', () => {
    expect(trimTail('0123456789', 4)).toBe('6789');
  });

  it('has a usable default cap', () => {
    expect(TERMINAL_BUFFER_CHARS).toBeGreaterThan(0);
  });
});
