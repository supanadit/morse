import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOT_HOST_XDG_CONFIG_HOME_ENV,
  BOT_HOST_XDG_DATA_HOME_ENV,
  botUserSpaceEnv,
  botUserSpacePluginPath,
  writeBotUserSpacePlugin,
} from './bot-user-space.js';

describe('botUserSpaceEnv', () => {
  it('redirects both XDG roots into the bot and carries the host roots separately', () => {
    const botRoot = '/bots/forge';

    const env = botUserSpaceEnv(botRoot, { PATH: '/usr/bin', HOME: '/home/u' });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      XDG_CONFIG_HOME: join(botRoot, 'config'),
      XDG_DATA_HOME: join(botRoot, 'sessions'),
      [BOT_HOST_XDG_CONFIG_HOME_ENV]: '/home/u/.config',
      [BOT_HOST_XDG_DATA_HOME_ENV]: '/home/u/.local/share',
    });
  });

  it('keeps a custom host XDG value as the shell value', () => {
    const env = botUserSpaceEnv('/bots/forge', {
      XDG_CONFIG_HOME: '/home/u/.xdg/config',
      XDG_DATA_HOME: '/home/u/.xdg/data',
    });

    expect(env[BOT_HOST_XDG_CONFIG_HOME_ENV]).toBe('/home/u/.xdg/config');
    expect(env[BOT_HOST_XDG_DATA_HOME_ENV]).toBe('/home/u/.xdg/data');
    expect(env['XDG_CONFIG_HOME']).toBe('/bots/forge/config');
    expect(env['XDG_DATA_HOME']).toBe('/bots/forge/sessions');
  });

  it('omits the host roots when neither XDG nor HOME is set', () => {
    const env = botUserSpaceEnv('/bots/forge', { PATH: '/usr/bin' });

    expect(env).not.toHaveProperty(BOT_HOST_XDG_CONFIG_HOME_ENV);
    expect(env).not.toHaveProperty(BOT_HOST_XDG_DATA_HOME_ENV);
  });

  it('falls back to $HOME/.config when the host config root is relative', () => {
    const env = botUserSpaceEnv('/bots/forge', {
      HOME: '/home/u',
      XDG_CONFIG_HOME: 'relative/config',
    });

    expect(env[BOT_HOST_XDG_CONFIG_HOME_ENV]).toBe('/home/u/.config');
    expect(env[BOT_HOST_XDG_DATA_HOME_ENV]).toBe('/home/u/.local/share');
  });

  it('falls back to $HOME/.local/share when the host data root is empty', () => {
    const env = botUserSpaceEnv('/bots/forge', {
      HOME: '/home/u',
      XDG_DATA_HOME: '',
    });

    expect(env[BOT_HOST_XDG_CONFIG_HOME_ENV]).toBe('/home/u/.config');
    expect(env[BOT_HOST_XDG_DATA_HOME_ENV]).toBe('/home/u/.local/share');
  });

  it('omits a relative host root when there is no absolute HOME to fall back to', () => {
    const env = botUserSpaceEnv('/bots/forge', { XDG_CONFIG_HOME: 'relative/config' });

    expect(env).not.toHaveProperty(BOT_HOST_XDG_CONFIG_HOME_ENV);
    expect(env).not.toHaveProperty(BOT_HOST_XDG_DATA_HOME_ENV);
  });
});

describe('writeBotUserSpacePlugin', () => {
  let botRoot: string;

  beforeEach(() => {
    botRoot = mkdtempSync(join(tmpdir(), 'morse-bot-user-space-'));
  });

  afterEach(() => {
    rmSync(botRoot, { recursive: true, force: true });
  });

  it('writes the V2 shell hook into the bot config directory', () => {
    writeBotUserSpacePlugin(botRoot);

    const path = botUserSpacePluginPath(botRoot);
    expect(path).toBe(join(botRoot, 'config', 'opencode', 'plugins', 'morse-user-space.ts'));
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('Plugin.define');
    expect(source).toContain('id: "morse.user-space"');
    expect(source).toContain('ctx.shell.hook("create.before"');
    expect(source).toContain(BOT_HOST_XDG_CONFIG_HOME_ENV);
    expect(source).toContain(BOT_HOST_XDG_DATA_HOME_ENV);
    expect(source).toContain('event.env.XDG_CONFIG_HOME = configHome');
    expect(source).toContain('event.env.XDG_DATA_HOME = dataHome');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is idempotent', () => {
    writeBotUserSpacePlugin(botRoot);
    const first = readFileSync(botUserSpacePluginPath(botRoot), 'utf8');

    writeBotUserSpacePlugin(botRoot);

    expect(readFileSync(botUserSpacePluginPath(botRoot), 'utf8')).toBe(first);
  });
});
