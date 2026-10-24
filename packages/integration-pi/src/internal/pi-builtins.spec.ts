import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearBuiltinCommandsCache,
  getBuiltinSlashCommands,
} from './pi-builtins.js';
import { piPackageRoot, readPiVersion } from './pi-install.js';
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
  mkdirSync(root, { recursive: true });
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

/**
 * The launcher `pi.dev/install.sh` writes at `<agent>/bin/pi`, shortened but
 * structurally exact: it resolves its own symlinks, reads
 * `<agent>/install/current-version` and execs that release's bin. Nothing in
 * or above it is a manifest — the shape that left the palette without builtins.
 */
const MANAGED_LAUNCHER = [
  '#!/bin/sh',
  'pi_launcher=$0',
  'while [ -L "$pi_launcher" ]; do',
  '  pi_link=$(readlink "$pi_launcher") || exit 1',
  '  case "$pi_link" in',
  '    /*) pi_launcher="$pi_link" ;;',
  '    *) pi_launcher=${pi_launcher%/*}/$pi_link ;;',
  '  esac',
  'done',
  'pi_bin_dir=${pi_launcher%/*}',
  'pi_agent_dir=${pi_bin_dir%/*}',
  'pi_current_file=$pi_agent_dir/install/current-version',
  'IFS= read -r pi_current_version < "$pi_current_file" || exit 1',
  'pi_release_bin=$pi_agent_dir/install/releases/$pi_current_version/node_modules/.bin/pi',
  '[ -x "$pi_release_bin" ] || exit 1',
  'exec "$pi_release_bin" "$@"',
].join('\n');

/**
 * A managed install (releases-v1) exactly as install.sh lays it out: launcher
 * at `<base>/agent/bin/pi`, `install/` beside it, and the package npm ci
 * installed under `install/releases/<version>/node_modules`. Returns the
 * PATH entry Morse resolves — `<base>/path-bin/pi`, a symlink to the launcher,
 * the way `write_managed_install_link` puts it on PATH.
 */
function setupManagedPi(
  base: string,
  slashCommandsJs: string,
  version = '9.9.9',
): { entry: string; launcher: string; installDir: string; root: string } {
  const agentRoot = join(base, 'agent');
  const binDir = join(agentRoot, 'bin');
  const installDir = join(agentRoot, 'install');
  const releaseDir = join(installDir, 'releases', version);
  const root = join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(releaseDir, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(
    join(installDir, 'managed-install.json'),
    JSON.stringify({
      kind: 'pi-managed-install',
      schemaVersion: 1,
      layout: 'releases-v1',
      entrypoint: { type: 'script', path: join(binDir, 'pi') },
    }),
  );
  writeFileSync(join(installDir, 'current-version'), `${version}\n`);
  // The release root is an installer meta-package *depending* on pi — which is
  // why walking up from the launcher never meets pi's own manifest.
  writeFileSync(
    join(releaseDir, 'package.json'),
    JSON.stringify({
      name: 'pi-managed-install',
      version,
      dependencies: { '@earendil-works/pi-coding-agent': version },
    }),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, type: 'module' }),
  );
  writeFileSync(join(root, 'dist', 'bundle', 'cli.js'), '');
  writeSlashCommands(root, slashCommandsJs);
  symlinkSync(
    join('..', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
    join(releaseDir, 'node_modules', '.bin', 'pi'),
  );
  writeFileSync(join(binDir, 'pi'), `${MANAGED_LAUNCHER}\n`, { mode: 0o755 });
  const pathBin = join(base, 'path-bin');
  mkdirSync(pathBin, { recursive: true });
  symlinkSync(join('..', 'agent', 'bin', 'pi'), join(pathBin, 'pi'));
  return { entry: join(pathBin, 'pi'), launcher: join(binDir, 'pi'), installDir, root };
}

function spawnFor(root: string): { spawn: { command: string; args: string[]; source: 'configured' } } {
  // A configured binary under `bin/` resolves: bin/ -> package root.
  return { spawn: { command: join(root, 'bin', 'pi'), args: [], source: 'configured' } };
}

/**
 * A shim as cmd-shim writes it (npm, and pnpm's copied POSIX shim): its own
 * directory as `$basedir`/`%dp0%`, references that climb out of the shim's bin
 * directory into a store, and — for pnpm — a `# cmd-shim-target=` trailer. The
 * real pi is never above the shim, so only following these references resolves.
 */
function writeCmdShim(
  shim: string,
  references: { sh: string; cmd: string; ps1: string },
  target?: string,
): void {
  mkdirSync(dirnameOf(shim), { recursive: true });
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\\\,/,g\')")',
      'if [ -x "$basedir/node" ]; then',
      `  exec "$basedir/node" "${references.sh}" "$@"`,
      'else',
      `  exec node "${references.sh}" "$@"`,
      'fi',
      ...(target === undefined ? [] : [`# cmd-shim-target=${target}`]),
      '',
    ].join('\n'),
  );
  writeFileSync(
    `${shim}.cmd`,
    [
      '@ECHO off',
      'SET dp0=%~dp0',
      `node "%~dp0${references.cmd}" %*`,
      '',
    ].join('\r\n'),
  );
  writeFileSync(
    `${shim}.ps1`,
    [
      '#!/usr/bin/env pwsh',
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      `& "${references.ps1}" $args`,
      'exit $LASTEXITCODE',
      '',
    ].join('\n'),
  );
}

/**
 * A pnpm global install on POSIX: `$PNPM_HOME/bin/pi` is a copied `sh` shim into
 * `$PNPM_HOME/global/<store>/node_modules/.pnpm/...`, so no pi manifest is above
 * the shim and (unlike npm) no symlink points at the package either. The store
 * hash is fake here; the shim is the real cmd-shim shape.
 */
function setupPnpmInstall(base: string, slashCommandsJs: string): { shim: string; root: string } {
  const store = join(base, 'global', 'v11', 'a'.repeat(64), 'node_modules', '.pnpm');
  const packageDir = join(store, 'pi-coding-agent@9.9.9', 'node_modules', '@earendil-works', 'pi-coding-agent');
  setupPi(packageDir, slashCommandsJs);
  mkdirSync(join(packageDir, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(packageDir, 'dist', 'bundle', 'cli.js'), '#!/usr/bin/env node\n');

  // The path the shim names, as each shell spells it, relative to `bin/` because
  // that is where the shim sits. The pnpm shim is the real article: the store
  // path is written into every branch and repeated in the target trailer.
  const entry = join('..', 'global', 'v11', 'a'.repeat(64), 'node_modules', '.pnpm', 'pi-coding-agent@9.9.9', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  const shim = join(base, 'bin', 'pi');
  writeCmdShim(
    shim,
    {
      sh: `$basedir/${toSlashes(entry)}`,
      cmd: toBackslashes(entry),
      ps1: `$basedir/${toSlashes(entry)}`,
    },
    toSlashes(join(base, entry)),
  );
  return { shim, root: packageDir };
}

const toSlashes = (path: string): string => path.replace(/\\/g, '/');
const toBackslashes = (path: string): string => path.replace(/\//g, '\\');

/**
 * A bun global install on Windows. bun cannot symlink and cannot run a shebang,
 * so it writes `pi.exe` — a real PE — beside a `pi.bunx` whose UTF-16 payload
 * names the target, and reads it back at launch. The payload is stored relative
 * to the shim's *grandparent* (`~/.bun`), with a leading `..\` removed, which the
 * payload here reproduces with bun's real `install/global/node_modules` layout.
 */
function setupBunInstall(base: string, slashCommandsJs: string): { shim: string; root: string } {
  const root = join(base, 'install', 'global', 'node_modules', '@earendil-works', 'pi-coding-agent');
  setupPi(root, slashCommandsJs);
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'dist', 'bundle', 'cli.js'), '#!/usr/bin/env node\n');

  const shim = join(base, 'bin', 'pi.exe');
  mkdirSync(dirnameOf(shim), { recursive: true });
  // A PE is opaque to a text scan, so its bytes only have to not look like one;
  // the real shim's magic is not what any reader on our side touches.
  writeFileSync(shim, Buffer.from('MZ\u0000\u0000bun-shim\u0000', 'latin1'));
  const reference = ['install', 'global', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'].join('\\');
  writeFileSync(
    `${shim.slice(0, -'.exe'.length)}.bunx`,
    Buffer.from(`${reference}"`, 'utf16le'),
  );
  return { shim, root };
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

  // Regression: issue #1 — a bash-script (managed) pi has no manifest above
  // its launcher, so the walk-up alone reported an unreadable install.
  it('resolves the package root behind a managed install.sh launcher', () => {
    const managed = setupManagedPi(
      tempDir('morse-pibuiltins-managed-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    expect(piPackageRoot(managed.entry)).toBe(managed.root);
    // Also when pi resolves straight to the launcher (no PATH symlink).
    expect(piPackageRoot(managed.launcher)).toBe(managed.root);
  });

  it('keeps a managed tree whose current-version is not a release name from being read', () => {
    const managed = setupManagedPi(
      tempDir('morse-pibuiltins-managed-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    writeFileSync(join(managed.installDir, 'current-version'), '../..\n');
    expect(piPackageRoot(managed.entry)).toBeUndefined();
  });

  // A pnpm global install leaves a *copied* shim, not a symlink, so the walk-up
  // meets a bin directory and only the store path written inside the shim leads
  // to pi.
  it('follows a pnpm POSIX shim, which is not a symlink', () => {
    const install = setupPnpmInstall(
      tempDir('morse-pibuiltins-pnpm-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    expect(piPackageRoot(install.shim)).toBe(install.root);
  });

  it('follows a Windows .cmd shim whose store path is relative to itself', () => {
    const install = setupPnpmInstall(
      tempDir('morse-pibuiltins-cmd-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    expect(piPackageRoot(`${install.shim}.cmd`)).toBe(install.root);
    expect(piPackageRoot(`${install.shim}.ps1`)).toBe(install.root);
  });

  // The PowerShell installer puts `.cmd`/`.ps1` launchers beside the sh launcher
  // and prepends that bin dir to the user PATH, so a Windows managed install
  // needs both the shim and the managed layout to be recognized together.
  it('resolves a managed install entered through its pi.cmd launcher', () => {
    const managed = setupManagedPi(
      tempDir('morse-pibuiltins-managed-win-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    writeCmdShim(
      managed.launcher,
      { sh: '$basedir/pi-launcher.js', cmd: 'pi-launcher.js', ps1: '$basedir/pi-launcher.js' },
    );
    expect(piPackageRoot(`${managed.launcher}.cmd`)).toBe(managed.root);
  });

  // bun on Windows is the one install shape that is neither a symlink nor a text
  // shim: a compiled `.exe` and a UTF-16 sidecar. Both were opaque to every step
  // above, so a bun-global pi resolved to nothing (issue #1's Windows analogue).
  it('resolves a bun Windows .exe shim through its .bunx sidecar', () => {
    const install = setupBunInstall(
      tempDir('morse-pibuiltins-bun-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    expect(piPackageRoot(install.shim)).toBe(install.root);
  });
});

describe('readPiVersion', () => {
  it('reads the version pi itself names, through a managed install', () => {
    const managed = setupManagedPi(
      tempDir('morse-pibuiltins-version-managed-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
      '4.5.6',
    );
    expect(readPiVersion({ command: managed.entry, args: [], source: 'path' })).toBe('4.5.6');
    // The PowerShell installer leaves `.cmd`/`.ps1` beside the launcher; both
    // enter the same managed tree as the sh launcher does.
    writeCmdShim(
      managed.launcher,
      { sh: '$basedir/pi-launcher.js', cmd: 'pi-launcher.js', ps1: '$basedir/pi-launcher.js' },
    );
    expect(readPiVersion({ command: `${managed.launcher}.cmd`, args: [], source: 'path' })).toBe('4.5.6');
    expect(readPiVersion({ command: `${managed.launcher}.ps1`, args: [], source: 'path' })).toBe('4.5.6');
  });

  it('reads the version through a pnpm POSIX shim', () => {
    const install = setupPnpmInstall(
      tempDir('morse-pibuiltins-version-pnpm-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    expect(readPiVersion({ command: install.shim, args: [], source: 'path' })).toBe('9.9.9');
  });

  it('reads the version of a bun Windows install through its .exe shim', () => {
    const install = setupBunInstall(
      tempDir('morse-pibuiltins-version-bun-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    expect(readPiVersion({ command: install.shim, args: [], source: 'path' })).toBe('9.9.9');
  });

  // `powershell -File <shim>` resolves pi's entry to the shim in the args, not
  // the command.
  it('reads the version of a pi started through powershell -File', () => {
    const install = setupPnpmInstall(
      tempDir('morse-pibuiltins-version-ps1-'),
      'export const BUILTIN_SLASH_COMMANDS = [];',
    );
    expect(
      readPiVersion({
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${install.shim}.ps1`],
        source: 'path',
      }),
    ).toBe('9.9.9');
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

  // Regression: issue #1 — the banner "Morse could not read the built-in slash
  // commands" showed for pi installed by `curl pi.dev/install.sh | sh`.
  it('reads the builtins from a managed (bash installer) pi', () => {
    const managed = setupManagedPi(tempDir('morse-pibuiltins-managed-'), literal);
    const result = getBuiltinSlashCommands({
      command: managed.entry,
      args: [],
      source: 'path',
    } as never);
    expect(result).toEqual({
      root: managed.root,
      version: '9.9.9',
      commands: [
        { name: 'settings', description: 'Open settings menu' },
        { name: 'model', description: 'Select model', argumentHint: '<provider/model>' },
        { name: 'brk', description: 'a]b and ]}' },
        { name: 'dedupe', description: 'first' },
      ],
    });
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

  // Regression: issue #1 — this diagnostic was the warning banner users saw
  // for a managed pi, though the install was perfectly readable.
  it('reads a managed pi without the unreadable-install diagnostic', async () => {
    const managed = setupManagedPi(tempDir('morse-pibuiltins-managed-'), literal);
    const context: CommandContext = {
      cwd: tempDir('morse-pibuiltins-cwd-'),
      env: { PI_CODING_AGENT_DIR: tempDir('morse-pibuiltins-agent-') },
      spawn: { command: managed.entry, args: [], source: 'path' } as never,
    };
    const { commands, diagnostics } = await buildCommandList(
      [{ name: 'ask-user', source: 'extension' }],
      context,
    );
    expect(commands.map((command) => command.name)).toEqual(['settings', 'model', 'ask-user']);
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