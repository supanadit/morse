import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { morseDataDir, morseSessionsDir } from './data-dir.js';

/**
 * Both hosts (server and VS Code extension) build their session index directory
 * from this one helper — that is the parity contract itself, so what matters
 * here is only the two shapes it can take: the explicit override and the
 * default under the home directory.
 */
describe('morseDataDir', () => {
  it('honours an explicit MORSE_HOME, trimmed', () => {
    expect(morseDataDir({ MORSE_HOME: ' /data/morse ' })).toBe('/data/morse');
  });

  it('falls back to ~/.morse when MORSE_HOME is missing or blank', () => {
    expect(morseDataDir({})).toBe(join(homedir(), '.morse'));
    expect(morseDataDir({ MORSE_HOME: '   ' })).toBe(join(homedir(), '.morse'));
  });

  it('puts the session index under the data directory', () => {
    expect(morseSessionsDir({ MORSE_HOME: '/data/morse' })).toBe(join('/data/morse', 'sessions'));
  });
});
