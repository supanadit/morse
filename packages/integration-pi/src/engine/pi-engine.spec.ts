import { JsonConfigFile, UnsupportedScopeError, resolveEngineContext } from '@morse/engine-config';
import { describe, expect, it } from 'vitest';

import { PiEngineDefinition, PiEngineInstance } from './pi-engine.js';
import { PiMcpStore } from './pi-mcp-store.js';

const engine = new PiEngineDefinition();

/** A user instance over fixed, fake roots: nothing here touches the real home. */
function user(
  cwd: string | undefined = '/work/app',
  env: NodeJS.ProcessEnv = {},
): PiEngineInstance {
  return engine.create(resolveEngineContext({ ownership: 'user', home: '/home/me', cwd, env }));
}

describe('PiEngineDefinition', () => {
  it('resolves the global and the project MCP paths in precedence order', () => {
    const instance = user();

    expect(instance.paths('mcp', 'global')).toEqual({
      read: ['/home/me/.pi/agent/mcp.json'],
      write: '/home/me/.pi/agent/mcp.json',
    });
    expect(instance.paths('mcp', 'project')).toEqual({
      read: ['/work/app/.pi/mcp.json', '/home/me/.pi/agent/mcp.json'],
      write: '/work/app/.pi/mcp.json',
    });
    // An explicit directory wins over the instance's own session directory.
    expect(instance.paths('mcp', 'project', '/other/app')).toEqual({
      read: ['/other/app/.pi/mcp.json', '/home/me/.pi/agent/mcp.json'],
      write: '/other/app/.pi/mcp.json',
    });
  });

  it('honours PI_CODING_AGENT_DIR for the user agent dir', () => {
    const instance = user('/work/app', { PI_CODING_AGENT_DIR: '/custom/agent' });

    expect(instance.paths('mcp', 'global')).toEqual({
      read: ['/custom/agent/mcp.json'],
      write: '/custom/agent/mcp.json',
    });
    expect(instance.paths('mcp', 'project').read).toEqual([
      '/work/app/.pi/mcp.json',
      '/custom/agent/mcp.json',
    ]);
  });

  it('builds an isolated instance over its own root and refuses the project scope', () => {
    const bot = engine.isolated('/bots/x/config', { home: '/home/me', env: {} });

    expect(bot.context.ownership).toBe('isolated');
    expect(bot.context.root).toBe('/bots/x/config');
    expect(bot.definition.kind).toBe('pi');
    expect(bot.mcp).toBeInstanceOf(PiMcpStore);
    // Prompt templates arrive with Task 8.
    expect(bot.prompts).toBeUndefined();
    expect(bot.paths('mcp', 'global')).toEqual({
      read: ['/bots/x/config/mcp.json'],
      write: '/bots/x/config/mcp.json',
    });
    expect(() => bot.paths('mcp', 'project')).toThrow(UnsupportedScopeError);
    expect(() => bot.paths('mcp', 'project', '/work/app')).toThrow(UnsupportedScopeError);
    expect(() => bot.file('mcp', 'project')).toThrow(UnsupportedScopeError);
  });

  it('names the project file as project and every other path as global', () => {
    const instance = user();
    const project = instance.paths('mcp', 'project');

    expect(instance.scopeOf('mcp', project.write)).toBe('project');
    expect(instance.scopeOf('mcp', '/work/app/.pi/mcp.json')).toBe('project');
    expect(instance.scopeOf('mcp', '/home/me/.pi/agent/mcp.json')).toBe('global');
    expect(instance.scopeOf('mcp', '/elsewhere/mcp.json')).toBe('global');
  });

  it('opens every file with the instance ownership', () => {
    const instance = user();
    const global = instance.file('mcp', 'global');
    const project = instance.file('mcp', 'project');

    expect(global).toBeInstanceOf(JsonConfigFile);
    expect(global.path).toBe('/home/me/.pi/agent/mcp.json');
    expect(project).toBeInstanceOf(JsonConfigFile);
    expect(project.path).toBe('/work/app/.pi/mcp.json');
    expect(project.scope).toBe('project');

    const bot = engine.isolated('/bots/x/config', { home: '/home/me', env: {} });
    const botFile = bot.fileAt('mcp', '/bots/x/config/mcp.json', 'global');
    expect(botFile).toBeInstanceOf(JsonConfigFile);
    expect(botFile.path).toBe('/bots/x/config/mcp.json');
  });

  it('needs a project directory for the project scope', () => {
    const instance = engine.create(
      resolveEngineContext({ ownership: 'user', home: '/home/me', env: {} }),
    );
    expect(instance.context.cwd).toBeUndefined();
    expect(() => instance.paths('mcp', 'project')).toThrow(/project directory/i);
  });

  it('refuses a file id pi does not own yet', () => {
    expect(() => user().paths('settings', 'global')).toThrow(/no config file/i);
  });
});
