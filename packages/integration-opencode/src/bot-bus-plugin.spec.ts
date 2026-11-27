import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_BUS_PLUGIN_END,
  OPENCODE_BUS_PLUGIN_FILE,
  OPENCODE_BUS_PLUGIN_START,
  isOpenCodeBusPlugin,
  openCodeBusPluginPath,
  openCodeBusPluginSource,
  writeOpenCodeBusPlugin,
} from './bot-bus-plugin.js';

/**
 * The plugin is generated source, loaded by OpenCode from the bot's own config
 * tree. It is never executed here — its `@opencode/plugin` import only resolves
 * inside an OpenCode process — so what these tests pin is the text a bot's
 * OpenCode will run and the endpoint the host already answers.
 */
describe('openCodeBusPluginSource', () => {
  it('names the file OpenCode discovers and wraps it in the markers repair reads', () => {
    expect(OPENCODE_BUS_PLUGIN_FILE).toBe('morse-bot-bus.ts');
    expect(OPENCODE_BUS_PLUGIN_START).toBe('// morse-bot-bus:start v3');
    expect(OPENCODE_BUS_PLUGIN_END).toBe('// morse-bot-bus:end');
    const source = openCodeBusPluginSource();
    expect(source.startsWith(`${OPENCODE_BUS_PLUGIN_START}\n`)).toBe(true);
    expect(source.trimEnd().endsWith(OPENCODE_BUS_PLUGIN_END)).toBe(true);
  });

  it('registers all four tools through the plugin tool transform', () => {
    const source = openCodeBusPluginSource();

    expect(source).toContain('Plugin.define');
    expect(source).toContain('id: "morse.bot-bus"');
    expect(source).toContain('ctx.tool.transform');
    expect(source).toContain('editor.add');
    expect(source).toContain('name: "bot_list"');
    expect(source).toContain('name: "bot_send"');
    expect(source).toContain('name: "human_list"');
    expect(source).toContain('name: "human_send"');
  });

  it('reads its endpoint, token and turn from the environment', () => {
    const source = openCodeBusPluginSource();

    expect(source).toContain('MORSE_BUS_URL');
    expect(source).toContain('MORSE_BUS_TOKEN_FILE');
    expect(source).toContain('MORSE_BUS_TURN_FILE');
    // One endpoint, one path per tool: the host owns every rule behind it.
    expect(source).toContain('/internal/bot-bus/');
    expect(source).toContain('Authorization');
    expect(source).toContain('Bearer');
    expect(source).toContain("'Content-Type'");
  });

  it('shapes bot_list with no arguments and bot_send with to, text and an optional kind', () => {
    const source = openCodeBusPluginSource();

    // bot_list takes nothing, and says so in its schema.
    expect(source).toContain(
      'input: { type: "object", properties: {}, additionalProperties: false }',
    );
    expect(source).toContain('required: ["to", "text"]');
    expect(source).toContain('enum: ["message", "assign", "reply"]');
    expect(source).toContain('additionalProperties: false');
  });

  it("tells the reader the file is Morse's and is replaced whole", () => {
    const source = openCodeBusPluginSource();

    expect(source).toContain('This file belongs to Morse and is replaced whole');
    expect(source).toContain('separate file');
    // The plugins directory also holds the reader's own plugins: the comment must
    // not invite them to edit this one.
    expect(source).not.toMatch(/outside the markers/i);
    expect(source).not.toMatch(/your own plugins/i);
  });

  it('reads the token and the live turn at call time, never at load', () => {
    const source = openCodeBusPluginSource();

    // Both are read inside calls, so a token Morse re-minted after the session
    // started takes effect on the next call.
    expect(source).toMatch(/function readToken\(\)/);
    expect(source).toMatch(/function hasActiveTurn\(\)/);
    expect(source).toMatch(/const token = readToken\(\)/);
    expect(source).toContain('if (!hasActiveTurn()) return');
    // Nothing at module scope captures a credential path or value.
    expect(source).not.toMatch(/^const .*MORSE_BUS_/m);
    expect(source).not.toMatch(/^let .*MORSE_BUS_/m);
  });

  it('sends only the tool arguments, because the host re-reads its own turn file', () => {
    const source = openCodeBusPluginSource();

    expect(source).toContain('body: JSON.stringify(body),');
    expect(source).not.toContain('...body, turn');
    expect(source).not.toContain('turn }');
  });

  it('passes the tool call signal, so an aborted turn stops the request', () => {
    const source = openCodeBusPluginSource();

    // `context.signal` is the tool call's AbortSignal; the request carries it.
    expect(source).toContain('context.signal');
    expect(source).toMatch(/^\s+signal,$/m);
  });

  it('returns a readable sentence instead of throwing on every failure', () => {
    const source = openCodeBusPluginSource();

    expect(source).toContain('No active turn — answer the person.');
    expect(source).toContain('Could not reach Morse:');
    expect(source).toContain(' — answer the person.');
    expect(source).toMatch(/catch\s*\(/);
    // The turn file is read and parsed behind the same guard: a half-written file
    // is "no turn", not an exception inside the bot's turn.
    expect(source).toMatch(/try \{\n\s+value = JSON\.parse\(readFileSync\(/);
  });

  it('returns the roster as one readable line per bot', () => {
    const source = openCodeBusPluginSource();

    expect(source).toContain('@${username} — ${name}: ${description} (${state}, ${where})');
    expect(source).toMatch(/["']working["']/);
    expect(source).toContain('`queued ${queued}`');
    expect(source).toMatch(/["']idle["']/);
    expect(source).toMatch(/["']in this room["']/);
    expect(source).toMatch(/["']elsewhere["']/);
    expect(source).toContain('No bots are on this Morse yet');
    // A 200 body without a `bots` array is unreadable, not an empty roster.
    expect(source).toContain('Could not read the roster from Morse');
    expect(source).toContain('if (!Array.isArray(listed))');
  });

  it('returns the delivery result as text', () => {
    const source = openCodeBusPluginSource();

    expect(source).toContain('Queued to @');
    expect(source).toContain('Morse did not queue it:');
    // A `{ error }` body is a sentence the bot can read and act on, not a throw.
    expect(source).toContain("answer['error']");
    expect(source).toMatch(/["']refused["']/);
  });

  it('imports nothing from Morse at runtime', () => {
    const source = openCodeBusPluginSource();

    // The file lives in a bot's config directory and OpenCode loads it there; it
    // may only use node's own fs, the environment, HTTP and the plugin API.
    expect(source).not.toContain('@morse/');
    expect(source).toMatch(/from "node:fs"/);
    expect(source).toMatch(/from "@opencode\/plugin"/);
  });
});

describe('openCodeBusPluginPath', () => {
  it('points at OpenCode plugins directory inside the bot config', () => {
    const botRoot = '/bots/forge';

    expect(openCodeBusPluginPath(botRoot)).toBe(
      join(botRoot, 'config', 'opencode', 'plugins', OPENCODE_BUS_PLUGIN_FILE),
    );
  });
});

describe('isOpenCodeBusPlugin', () => {
  it('accepts only the version this code writes', () => {
    expect(isOpenCodeBusPlugin(openCodeBusPluginSource())).toBe(true);
    expect(isOpenCodeBusPlugin(undefined)).toBe(false);
    // A reader's own plugin at Morse's path, and an older Morse asset.
    expect(isOpenCodeBusPlugin('export default Plugin.define({ id: "mine" })\n')).toBe(false);
    expect(
      isOpenCodeBusPlugin('// morse-bot-bus:start v0\nexport default {};\n// morse-bot-bus:end\n'),
    ).toBe(false);
  });
});

describe('writeOpenCodeBusPlugin', () => {
  let botRoot: string;

  beforeEach(() => {
    botRoot = mkdtempSync(join(tmpdir(), 'morse-opencode-bus-plugin-'));
  });

  afterEach(() => {
    rmSync(botRoot, { recursive: true, force: true });
  });

  it('writes the plugin with the source OpenCode loads, readable only by its owner', () => {
    writeOpenCodeBusPlugin(botRoot);

    const path = openCodeBusPluginPath(botRoot);
    expect(readFileSync(path, 'utf8')).toBe(openCodeBusPluginSource());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is idempotent', () => {
    writeOpenCodeBusPlugin(botRoot);
    const first = readFileSync(openCodeBusPluginPath(botRoot), 'utf8');

    writeOpenCodeBusPlugin(botRoot);

    expect(readFileSync(openCodeBusPluginPath(botRoot), 'utf8')).toBe(first);
  });

  it('replaces a file that is not the current plugin at Morse’s path', () => {
    const path = openCodeBusPluginPath(botRoot);
    // The directory already holds a reader's file under Morse's name.
    writeOpenCodeBusPlugin(botRoot);
    writeFileSync(path, 'export default Plugin.define({ id: "mine" })\n');

    writeOpenCodeBusPlugin(botRoot);

    expect(readFileSync(path, 'utf8')).toBe(openCodeBusPluginSource());
  });
});
