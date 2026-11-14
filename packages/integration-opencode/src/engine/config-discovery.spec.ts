import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { UnsupportedScopeError, resolveEngineContext } from '@morse/engine-config';
import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverOpenCodeConfigPaths,
  discoverOpenCodeGlobalPaths,
  projectConfigCandidates,
} from './config-discovery.js';
import { OpenCodeEngineDefinition } from './open-code-engine.js';
import { OpenCodeMcpStore } from './open-code-mcp-store.js';
import { OpenCodePromptStore } from './open-code-prompt-store.js';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-opencode-discovery-'));
  roots.push(dir);
  return dir;
}

/** The would-be path a typed scope refusal carries, when it carries one. */
function refusalPath(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof UnsupportedScopeError ? error.path : undefined;
  }
  return undefined;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A user context over fixed, fake roots: nothing here touches the real home. */
function userContext(home: string, cwd?: string) {
  return resolveEngineContext({ ownership: 'user', home, cwd, env: {} });
}

/** Only the paths under `base`: ancestors above a temp root are not this test's. */
function under(paths: readonly string[], base: string): string[] {
  return paths.filter((path) => path === base || path.startsWith(`${base}${sep}`));
}

describe('config discovery', () => {
  it('reads json and jsonc in the global config dir, jsonc winning', () => {
    const home = root();
    const configDir = join(home, '.config', 'opencode');
    const json = join(configDir, 'opencode.json');
    const jsonc = join(configDir, 'opencode.jsonc');
    writeJson(json, { mcp: {} });
    writeFile(jsonc, '{\n  // a comment\n  "mcp": {}\n}\n');

    expect(discoverOpenCodeGlobalPaths(userContext(home))).toEqual({
      read: [jsonc, json],
      write: jsonc,
    });
  });

  it('writes opencode.json when no jsonc exists', () => {
    const home = root();
    const json = join(home, '.config', 'opencode', 'opencode.json');
    writeJson(json, { mcp: {} });

    expect(discoverOpenCodeGlobalPaths(userContext(home))).toEqual({ read: [json], write: json });
    // Neither file yet: the json is where the first write lands.
    const fresh = root();
    const freshJson = join(fresh, '.config', 'opencode', 'opencode.json');
    expect(discoverOpenCodeGlobalPaths(userContext(fresh))).toEqual({
      read: [freshJson],
      write: freshJson,
    });
  });

  it('resolves the global dir from XDG_CONFIG_HOME', () => {
    const base = root();
    const xdg = join(base, 'xdg');
    const json = join(xdg, 'opencode', 'opencode.json');
    writeJson(json, { mcp: {} });
    const context = resolveEngineContext({
      ownership: 'user',
      home: join(base, 'home'),
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(discoverOpenCodeGlobalPaths(context)).toEqual({ read: [json], write: json });
  });

  it('lets every .opencode config outrank every direct one, nearest first', () => {
    const base = root();
    const repo = join(base, 'repo');
    const app = join(repo, 'app');
    const home = join(base, 'home');
    const globalPath = join(home, '.config', 'opencode', 'opencode.json');
    writeJson(globalPath, { mcp: {} });
    writeJson(join(app, 'opencode.json'), { mcp: { app: { type: 'local', command: ['app'] } } });
    writeJson(join(repo, 'opencode.json'), { mcp: {} });
    writeFile(join(repo, '.opencode', 'opencode.jsonc'), '{\n  "mcp": {}\n}\n');

    const paths = discoverOpenCodeConfigPaths(userContext(home, app));

    expect(under(paths.read, base)).toEqual([
      // OpenCode's rule: the .opencode block wins over any direct file, even a
      // nearer one, so the ancestor's .opencode config is read first.
      join(repo, '.opencode', 'opencode.jsonc'),
      join(app, 'opencode.json'),
      join(repo, 'opencode.json'),
      globalPath,
    ]);
    expect(paths.write).toBe(join(repo, '.opencode', 'opencode.jsonc'));
  });

  it('reads a directory jsonc before its json, and .opencode ahead of both', () => {
    const base = root();
    const repo = join(base, 'repo');
    const globalPath = join(base, 'home', '.config', 'opencode', 'opencode.json');
    writeJson(globalPath, { mcp: {} });
    writeFile(join(repo, 'opencode.jsonc'), '{\n  "mcp": {}\n}\n');
    writeJson(join(repo, 'opencode.json'), { mcp: {} });
    writeFile(join(repo, '.opencode', 'opencode.jsonc'), '{\n  "mcp": {}\n}\n');
    writeJson(join(repo, '.opencode', 'opencode.json'), { mcp: {} });

    const paths = discoverOpenCodeConfigPaths(userContext(join(base, 'home'), repo));

    expect(under(paths.read, base)).toEqual([
      join(repo, '.opencode', 'opencode.jsonc'),
      join(repo, '.opencode', 'opencode.json'),
      join(repo, 'opencode.jsonc'),
      join(repo, 'opencode.json'),
      globalPath,
    ]);
    expect(paths.write).toBe(join(repo, '.opencode', 'opencode.jsonc'));
  });

  it('orders every .opencode candidate ahead of every direct one, nearest first', () => {
    expect(projectConfigCandidates('/w/app')).toEqual([
      '/w/app/.opencode/opencode.jsonc',
      '/w/app/.opencode/opencode.json',
      '/w/.opencode/opencode.jsonc',
      '/w/.opencode/opencode.json',
      '/.opencode/opencode.jsonc',
      '/.opencode/opencode.json',
      '/w/app/opencode.jsonc',
      '/w/app/opencode.json',
      '/w/opencode.jsonc',
      '/w/opencode.json',
      '/opencode.jsonc',
      '/opencode.json',
    ]);
  });

  it('writes the first existing project candidate instead of creating one', () => {
    const base = root();
    const repo = join(base, 'repo');
    const app = join(repo, 'app');
    writeFile(join(repo, '.opencode', 'opencode.jsonc'), '{\n  "mcp": {}\n}\n');

    expect(discoverOpenCodeConfigPaths(userContext(join(base, 'home'), app)).write).toBe(
      join(repo, '.opencode', 'opencode.jsonc'),
    );
  });

  it('creates opencode.json in the workspace when the project has none', () => {
    const base = root();
    const app = join(base, 'repo', 'app');
    mkdirSync(app, { recursive: true });

    expect(discoverOpenCodeConfigPaths(userContext(join(base, 'home'), app)).write).toBe(
      join(app, 'opencode.json'),
    );
  });

  it('returns one file for an isolated root', () => {
    const base = root();
    const botRoot = join(base, 'bots', 'x', 'config');
    const jsonc = join(botRoot, 'opencode', 'opencode.jsonc');
    writeFile(jsonc, '{\n  // the bot\'s own config\n  "mcp": {}\n}\n');
    const context = resolveEngineContext({
      ownership: 'isolated',
      root: botRoot,
      home: join(base, 'home'),
      env: {},
    });

    expect(discoverOpenCodeConfigPaths(context)).toEqual({ read: [jsonc], write: jsonc });

    const bare = join(base, 'bots', 'y', 'config');
    const json = join(bare, 'opencode', 'opencode.json');
    expect(
      discoverOpenCodeConfigPaths(
        resolveEngineContext({
          ownership: 'isolated',
          root: bare,
          home: join(base, 'home'),
          env: {},
        }),
      ),
    ).toEqual({ read: [json], write: json });
  });
});

describe('OpenCodeEngineInstance', () => {
  const engine = new OpenCodeEngineDefinition();

  it('resolves the global and project chains in precedence order', () => {
    const base = root();
    const cwd = join(base, 'repo');
    const other = join(base, 'other');
    const home = join(base, 'home');
    const globalPath = join(home, '.config', 'opencode', 'opencode.json');
    const projectPath = join(cwd, 'opencode.json');
    writeJson(globalPath, { mcp: {} });
    writeJson(projectPath, { mcp: {} });
    writeJson(join(other, 'opencode.json'), { mcp: {} });

    const instance = engine.create(userContext(home, cwd));

    expect(instance.paths('config', 'global')).toEqual({ read: [globalPath], write: globalPath });
    expect(instance.paths('config', 'project')).toEqual({
      read: [projectPath, globalPath],
      write: projectPath,
    });
    // An explicit directory wins over the instance's own session directory.
    expect(instance.paths('config', 'project', other)).toEqual({
      read: [join(other, 'opencode.json'), globalPath],
      write: join(other, 'opencode.json'),
    });
  });

  it('honours an injected config dir', () => {
    const base = root();
    const configDir = join(base, 'custom', 'opencode');
    const json = join(configDir, 'opencode.json');
    writeJson(json, { mcp: {} });
    const instance = new OpenCodeEngineDefinition({ configDir }).create(
      userContext(join(base, 'home'), join(base, 'repo')),
    );

    expect(instance.configDir).toBe(configDir);
    expect(instance.paths('config', 'global')).toEqual({ read: [json], write: json });
  });

  it('names the project files as project and the user file as global', () => {
    const base = root();
    const cwd = join(base, 'repo');
    const home = join(base, 'home');
    const globalPath = join(home, '.config', 'opencode', 'opencode.json');
    const projectPath = join(cwd, 'opencode.json');
    writeJson(globalPath, { mcp: {} });
    writeJson(projectPath, { mcp: {} });
    const instance = engine.create(userContext(home, cwd));
    const project = instance.paths('config', 'project', cwd);

    expect(project.read).toContain(projectPath);
    expect(instance.scopeOf('config', project.write)).toBe('project');
    expect(instance.scopeOf('config', projectPath)).toBe('project');
    expect(instance.scopeOf('config', join(cwd, '.opencode', 'opencode.jsonc'))).toBe('project');
    expect(instance.scopeOf('config', globalPath)).toBe('global');
    // The app-level spelling is derivable without a directory, resolved or not.
    expect(instance.scopeOf('config', join(home, '.config', 'opencode', 'opencode.jsonc'))).toBe(
      'global',
    );
    // A path this instance never resolved is refused, not reported as global.
    expect(() => instance.scopeOf('config', '/elsewhere/opencode.json')).toThrow(
      UnsupportedScopeError,
    );
    expect(() => instance.scopeOf('config', '/elsewhere/opencode.json')).toThrow(
      /not one of this OpenCode instance's config paths/,
    );
  });

  it('opens every file with the instance ownership', () => {
    const base = root();
    const cwd = join(base, 'repo');
    const home = join(base, 'home');
    const instance = engine.create(userContext(home, cwd));
    const project = instance.paths('config', 'project');

    expect(instance.fileAt('config', project.write, 'project').path).toBe(project.write);
    // A user file that is JSONC is read, then refused on write until it is fixed.
    writeFile(instance.paths('config', 'global').write, '{\n  // hand edit\n  "mcp": {}\n}\n');
    const file = instance.file('config', 'global');
    expect(file.read().strict).toBe(false);
    const refused = file.write({ mcp: {} });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'normalize', fixable: true });
  });

  it('refuses the project scope for an isolated root', () => {
    const base = root();
    const bot = engine.isolated(join(base, 'bots', 'x', 'config'));
    const rootPath = join(base, 'bots', 'x', 'config', 'opencode', 'opencode.json');

    expect(bot.ownership).toBe('isolated');
    expect(bot.definition.kind).toBe('opencode');
    expect(bot.paths('config', 'global')).toEqual({ read: [rootPath], write: rootPath });
    expect(() => bot.paths('config', 'project')).toThrow(UnsupportedScopeError);
    expect(() => bot.paths('config', 'project', join(base, 'repo'))).toThrow(UnsupportedScopeError);
    expect(() => bot.file('config', 'project')).toThrow(UnsupportedScopeError);
    // The refusal names the would-be project file, so an issue's `file` stays a
    // real path instead of the bare file id.
    expect(refusalPath(() => bot.paths('config', 'project', join(base, 'repo')))).toBe(
      join(base, 'repo', 'opencode.json'),
    );
  });

  it('exposes the MCP and prompt stores', () => {
    const instance = engine.create(userContext('/home/me', '/work/app'));

    expect(instance.mcp).toBeInstanceOf(OpenCodeMcpStore);
    expect(instance.mcp.fileId).toBe('config');
    expect(instance.prompts).toBeInstanceOf(OpenCodePromptStore);
  });

  it('rejects a file id it does not have', () => {
    const instance = engine.create(userContext('/home/me', '/work/app'));

    expect(() => instance.paths('prompts', 'global')).toThrow(/no config file "prompts"/);
  });
});
