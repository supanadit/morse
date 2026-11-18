import { describe, expect, it } from 'vitest';
import {
  PI_BUS_EXTENSION_FILE,
  PI_BUS_EXTENSION_START,
  piBusExtensionSource,
} from './bot-bus-plugin.js';

/**
 * The extension is generated source, loaded by pi's jiti from the bot's agent
 * dir. It is never executed here — its pi imports only resolve inside a pi
 * process — so what these tests pin is the text a reader's pi will run and the
 * host's endpoint already expects.
 */
describe('piBusExtensionSource', () => {
  it('names the file pi auto-loads and wraps it in the markers repair reads', () => {
    expect(PI_BUS_EXTENSION_FILE).toBe('morse-bot-bus.ts');
    expect(PI_BUS_EXTENSION_START).toBe('// morse-bot-bus:start v1');
    const source = piBusExtensionSource();
    expect(source.startsWith(`${PI_BUS_EXTENSION_START}\n`)).toBe(true);
    expect(source.trimEnd().endsWith('// morse-bot-bus:end')).toBe(true);
  });

  it('registers both tools and reads its endpoint from the environment', () => {
    const source = piBusExtensionSource();

    expect(source).toContain("name: 'bot_list'");
    expect(source).toContain("name: 'bot_send'");
    expect(source).toContain('registerTool');
    expect(source).toContain('MORSE_BUS_URL');
    expect(source).toContain('MORSE_BUS_TOKEN_FILE');
    expect(source).toContain('MORSE_BUS_TURN_FILE');
    // One endpoint, one tool per path: the host owns every rule behind it.
    expect(source).toContain('/internal/bot-bus/');
    expect(source).toContain('Authorization');
    expect(source).toContain('Bearer');
    expect(source).toContain("'Content-Type'");
  });

  it('shapes bot_send with to, text and an optional kind, and bot_list with no arguments', () => {
    const source = piBusExtensionSource();

    expect(source).toMatch(/to: Type\.String\(/);
    expect(source).toMatch(/text: Type\.String\(/);
    expect(source).toMatch(/kind: Type\.Optional\(/);
    expect(source).toMatch(/parameters: Type\.Object\(\{\}\)/);
  });

  it('reads the token and the live turn at call time, never at load', () => {
    const source = piBusExtensionSource();

    // Both credentials are read by helpers that run inside a call, so a token
    // Morse re-minted after the session started takes effect on the next call.
    expect(source).toMatch(/function readToken\(\)/);
    expect(source).toMatch(/function activeTurn\(\)/);
    expect(source).toContain('const token = readToken();');
    expect(source).toContain('const turn = activeTurn();');
    // Nothing at module scope captures a credential path or value.
    expect(source).not.toMatch(/^const .*MORSE_BUS_/m);
    expect(source).not.toMatch(/^let .*MORSE_BUS_/m);
  });

  it('reports a missing turn and a dead endpoint instead of throwing', () => {
    const source = piBusExtensionSource();

    expect(source).toContain('No active turn — answer the person.');
    expect(source).toContain('Could not reach Morse:');
    expect(source).toContain(' — answer the person.');
    expect(source).toMatch(/catch\s*\(/);
    // The file is read and parsed behind the same guard: a half-written turn
    // file is "no turn", not an exception inside the bot's turn.
    expect(source).toMatch(/try \{\n\s+value = JSON\.parse\(readFileSync\(/);
  });

  it('returns the roster as one readable line per bot', () => {
    const source = piBusExtensionSource();

    expect(source).toContain('@${username} — ${name}: ${description} (${state}, ${where})');
    expect(source).toContain("'working'");
    expect(source).toContain('`queued ${queued}`');
    expect(source).toContain("'idle'");
    expect(source).toContain("'in this room'");
    expect(source).toContain("'elsewhere'");
    expect(source).toContain('No bots are on this Morse yet');
  });

  it('returns the delivery result as text', () => {
    const source = piBusExtensionSource();

    expect(source).toContain('Queued to @');
    expect(source).toContain('Morse did not queue it:');
    // A `{ error }` body is a sentence the bot can read and act on, not a throw.
    expect(source).toContain("answer['error']");
    expect(source).toMatch(/'refused'/);
  });

  it('imports nothing from Morse at runtime', () => {
    const source = piBusExtensionSource();

    // The file lives in a bot's config dir and pi loads it with jiti; it may
    // only use node's own fs, the environment and HTTP.
    expect(source).not.toContain('@morse/');
    expect(source).toMatch(/from 'node:fs'/);
    expect(source).toMatch(/from '@earendil-works\/pi-coding-agent'/);
    expect(source).toMatch(/from '@earendil-works\/pi-ai'/);
  });
});
