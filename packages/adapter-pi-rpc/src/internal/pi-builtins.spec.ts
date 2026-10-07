import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearBuiltinCommandsCache,
  getBuiltinSlashCommands,
  piPackageRoot,
} from './pi-builtins.js';
import { buildCommandList, type CommandContext } from '../pi-rpc-agent.js';

/**
 * pi's TUI builtins are not in the RPC protocol (`get_commands` deliberately
 * carries only extensions, prompt templates and skills), so the palette reads
 * pi's own `dist/core/slash-commands.js` from the install the session runs. These
 * tests lock that read: the resolved root, the parse (including entries a naive
 * `]`-count would cut short and a template-literal description the sandboxed
 * literal read must hand to the subprocess import), the cache that follows an
 * upgrade to the file's mtime, and the shadowing pi's own TUI applies when an
 * extension command registers under a builtin's name.
 */

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** The commands pi's compiled module declares; `quit` quotes its name as such. */
function writeSlashCommands(root: string, body: string): string {
  const file = join(root, 'dist', 'core', 'slash-commands.js');
  mkdirSync(join(root, 'dist', 'core'), { recursive: true });
  writeFileSync(file, body);
  return file;
}

/** A minimal fake pi install: manifest, a dummy bin entry, and the module. */
function setupPi(root: string, slashCommandsJs: string, files?: Record<string, string>): string {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '9.9.9', type: 'module' }),
  );
  for (const [path, content] of Object.entries(files ?? {})) {
    mkdirSync(dirnameOf(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'pi'), '#!/bin/sh\n');
  writeSlashCommands(root, slashCommandsJs);
  return root;
}

function dirnameOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), 0));
}

function spawnFor(root: string): { spawn: { command: string; args: string[]; source: 'configured' } } {
  // A configured binary under `bin/` resolves: bin/ -> package root.
  return { spawn: { command: join(root, 'bin', 'pi'), args: [], source: 'configured' } };
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  clearBuiltinCommandsCache();
});

describe('piPackageRoot', () => {
  it('resolves the package root behind a pi entry', () => {
    const root = setupPi(tempDir('morse-pibuiltins-'), 'export const BUILTIN_SLASH_COMMANDS = [];');
    expect(piPackageRoot(join(root, 'bin', 'pi'))).toBe(root);
  });

  it('returns undefined for an entry without a pi manifest anywhere above', () => {
    const bare = tempDir('morse-pibuiltins-nopi-');
    writeFileSync(join(bare, 'not-pi'), '');
    expect(piPackageRoot(join(bare, 'not-pi'))).toBeUndefined();
  });
});

describe('getBuiltinSlashCommands', () => {
  const literal = [
    'export const BUILTIN_SLASH_COMMANDS = [',
    '    {name:"settings", description:"Open settings menu"},',
    // Unquoted-key style, like a minified build; both styles must parse.
    '{ name: "model", description: "Select model", argumentHint: "<provider/model>" },',
    // A `]` inside the description must not truncate the scan.
    "  { name: 'brk', description: 'a]b and ]}' },",
    // First of a duplicate name wins; name-less and empty entries drop.
    '    { name: "dedupe", description: "first" },',
    '    { name: "dedupe", description: "second" },',
    '    { description: "no name" },',
    '    { name: "", description: "empty" },',
    '];',
  ].join('\n');

  it('reads the declared list, hints and all, from the compiled module', () => {
    const root = setupPi(tempDir('morse-pibuiltins-'), literal);
    const result = getBuiltinSlashCommands(spawnFor(root).spawn as never);
    expect(result).toEqual({
      root,
      version: '9.9.9',
      commands: [
        { name: 'settings', description: 'Open settings menu' },
        { name: 'model', description: 'Select model', argumentHint: '<provider/model>' },
        { name: 'brk', description: 'a]b and ]}' },
        { name: 'dedupe', description: 'first' },
      ],
    });
  });

  it('re-reads when the module file changes, without a re-resolve', () => {
    const root = setupPi(tempDir('morse-pibuiltins-'), literal);
    const spawn = spawnFor(root).spawn as never;
    expect(getBuiltinSlashCommands(spawn)).toBeDefined();

    writeSlashCommands(root, `export const BUILTIN_SLASH_COMMANDS = [{name:"fresh"}];`);
    // Same-second writes can collapse onto one mtime; force unambiguous ones.
    utimesSync(join(root, 'dist', 'core', 'slash-commands.js'), new Date(2.5e13), new Date(2.5e13));
    const result = getBuiltinSlashCommands(spawn);
    expect(result?.commands).toEqual([{ name: 'fresh' }]);
  });

  it('hands a template-literal description to the subprocess import (sandbox has no APP_NAME)', () => {
    const root = setupPi(
      tempDir('morse-pibuiltins-'),
      [
        'import { APP_NAME } from "../config.js";',
        'export const BUILTIN_SLASH_COMMANDS = [',
        '    { name: "quit", description: `Quit ${APP_NAME}` },',
        '];',
      ].join('\n'),
      { 'dist/config.js': `export const APP_NAME = 'pi';` },
    );
    const result = getBuiltinSlashCommands(spawnFor(root).spawn as never);
    expect(result?.commands).toEqual([{ name: 'quit', description: 'Quit pi' }]);
  });

  it('returns undefined (gracefully) when the module itself is broken', () => {
    const root = setupPi(
      tempDir('morse-pibuiltins-'),
      'export const BUILTIN_SLASH_COMMANDS = [this is not valid javascript;',
    );
    expect(getBuiltinSlashCommands(spawnFor(root).spawn as never)).toBeUndefined();
  });

  it('returns undefined without a spawn or for a spawn with no pi install behind it', () => {
    expect(getBuiltinSlashCommands(undefined)).toBeUndefined();
    const empty = tempDir('morse-pibuiltins-bogus-');
    const bogus = { command: join(empty, 'not-pi'), args: [], source: 'configured' } as never;
    expect(getBuiltinSlashCommands(bogus)).toBeUndefined();
  });
});

describe('buildCommandList with a pi install', () => {
  const literal = [
    'export const BUILTIN_SLASH_COMMANDS = [',
    '    { name: "settings", description: "Open settings menu" },',
    '    { name: "model", description: "Select model", argumentHint: "<provider/model>" },',
    '];',
  ].join('\n');

  /** An isolated agent root (empty prompts) plus a workspace and the fake pi install. */
  function isolatedContext(root: string): CommandContext & { spawn: { command: string; args: string[]; source: 'configured' } } {
    const agentRoot = tempDir('morse-pibuiltins-agent-');
    mkdirSync(join(agentRoot, 'prompts'), { recursive: true });
    return {
      cwd: tempDir('morse-pibuiltins-cwd-'),
      env: { PI_CODING_AGENT_DIR: agentRoot },
      ...spawnFor(root),
    };
  }

  it('leads with pi builtins and hides a shadowing extension command with a diagnostic', async () => {
    const root = setupPi(tempDir('morse-pibuiltins-'), literal);
    const context = isolatedContext(root);
    const { commands, diagnostics } = await buildCommandList(
      [{ name: 'settings', source: 'extension', description: 'an extension' }],
      context,
    );
    expect(commands[0]).toEqual({
      name: 'settings',
      description: 'Open settings menu',
      source: 'builtin',
      argumentHint: undefined,
    });
    expect(commands.find((command) => command.source === 'extension')).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        key: 'pi-command-shadow:settings',
        level: 'warn',
        text: `/settings is a pi built-in; the extension command registered for that name was hidden, as pi's own TUI does.`,
      },
    ]);
  });

  it('keeps extension commands that do not collide, hints included', async () => {
    const root = setupPi(tempDir('morse-pibuiltins-'), literal);
    const context = isolatedContext(root);
    const { commands, diagnostics } = await buildCommandList(
      [{ name: 'ask-user', source: 'extension' }],
      context,
    );
    expect(commands.map((command) => command.name)).toEqual([
      'settings',
      'model',
      'ask-user',
    ]);
    expect(commands.find((command) => command.name === 'model')?.argumentHint).toBe(
      '<provider/model>',
    );
    expect(diagnostics).toEqual([]);
  });

  it('adds no builtins and no diagnostic for a context without a spawn (test setups)', async () => {
    const agentRoot = tempDir('morse-pibuiltins-agent-');
    mkdirSync(join(agentRoot, 'prompts'), { recursive: true });
    const context: CommandContext = {
      cwd: tempDir('morse-pibuiltins-cwd-'),
      env: { PI_CODING_AGENT_DIR: agentRoot },
    };
    expect(await buildCommandList([], context)).toEqual({ commands: [], diagnostics: [] });
  });

  it('reports an unreadable install but keeps the extensible list usable', async () => {
    const empty = tempDir('morse-pibuiltins-bogus-');
    const context: CommandContext = {
      cwd: tempDir('morse-pibuiltins-cwd-'),
      env: { PI_CODING_AGENT_DIR: tempDir('morse-pibuiltins-agent-') },
      spawn: { command: join(empty, 'not-pi'), args: [], source: 'configured' } as never,
    };
    const { commands, diagnostics } = await buildCommandList(
      [{ name: 'review', source: 'extension' }],
      context,
    );
    expect(commands.map((command) => command.name)).toEqual(['review']);
    expect(diagnostics).toEqual([
      {
        key: 'pi-builtins:unreadable',
        level: 'info',
        text: 'Morse could not read the built-in slash commands in the installed pi; the palette shows extension commands, prompt templates and skills.',
      },
    ]);
  });
});