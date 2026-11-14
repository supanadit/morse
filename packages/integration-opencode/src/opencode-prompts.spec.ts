import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodePrompts } from './opencode-prompts.js';
import { composeCommandFile } from './internal/opencode-prompts-config.js';

let root: string;
let globalBase: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-prompts-'));
  globalBase = join(root, 'xdg', 'opencode');
  workspace = join(root, 'ws');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('OpenCodePrompts', () => {
  it('round-trips a file command: create, list, edit, delete', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });
    const saved = prompts.save(
      { name: 'fresh', scope: 'project', raw: composeCommandFile('Fresh', '\nBody\n') },
      workspace,
    );
    expect(saved.ok && saved.source).toBe('file');
    const listed = prompts.list(workspace);
    const row = listed.templates.find((t) => t.name === 'fresh');
    expect(row).toMatchObject({ scope: 'project', source: 'file', description: 'Fresh' });
    expect(listed.trusted).toBe(true);
    expect(listed.projectDir).toBe(join(workspace, '.opencode', 'commands'));

    prompts.save(
      {
        name: 'fresh',
        scope: 'project',
        source: 'file',
        originalName: 'fresh',
        originalScope: 'project',
        raw: composeCommandFile('Fresh 2', '\nBody 2\n'),
      },
      workspace,
    );
    expect(prompts.list(workspace).templates.find((t) => t.name === 'fresh')?.description).toBe('Fresh 2');

    expect(prompts.delete('fresh', 'project', workspace, 'file').ok).toBe(true);
    expect(prompts.list(workspace).templates.some((t) => t.name === 'fresh')).toBe(false);
  });

  it('moves a file command between scopes, deleting the old file', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });
    prompts.save({ name: 'mv', scope: 'global', raw: composeCommandFile(undefined, '\nB\n') }, workspace);
    prompts.save(
      {
        name: 'mv',
        scope: 'project',
        source: 'file',
        originalName: 'mv',
        originalScope: 'global',
        raw: composeCommandFile(undefined, '\nB\n'),
      },
      workspace,
    );
    const rows = prompts.list(workspace).templates.filter((t) => t.name === 'mv');
    expect(rows.map((r) => r.scope)).toEqual(['project']);
  });

  it('round-trips a config command: upsert, list, edit, rename, delete', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });
    prompts.save(
      {
        name: 'cfg',
        scope: 'global',
        source: 'config',
        entry: { template: 'Body', description: 'D', agent: 'build', subtask: true },
      },
      workspace,
    );
    const row = prompts.list(workspace).templates.find((t) => t.name === 'cfg');
    expect(row?.source).toBe('config');
    expect(row?.entry?.agent).toBe('build');

    prompts.save(
      {
        name: 'cfg2',
        scope: 'global',
        source: 'config',
        originalName: 'cfg',
        originalSource: 'config',
        entry: { template: 'Body 2' },
      },
      workspace,
    );
    const renamed = prompts.list(workspace).templates.filter((t) => t.name === 'cfg' || t.name === 'cfg2');
    expect(renamed.map((r) => r.name)).toEqual(['cfg2']);

    expect(prompts.delete('cfg2', 'global', workspace, 'config').ok).toBe(true);
    expect(prompts.list(workspace).templates.some((t) => t.name === 'cfg2')).toBe(false);
  });

  it('keeps a same-named file and config command separate', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });
    prompts.save({ name: 'dual', scope: 'global', raw: composeCommandFile('F', '\nFile\n') }, workspace);
    prompts.save(
      { name: 'dual', scope: 'global', source: 'config', entry: { template: 'Config' } },
      workspace,
    );
    const rows = prompts.list(workspace).templates.filter((t) => t.name === 'dual');
    expect(rows.map((r) => r.source).sort()).toEqual(['config', 'file']);

    prompts.delete('dual', 'global', workspace, 'file');
    const after = prompts.list(workspace).templates.filter((t) => t.name === 'dual');
    expect(after.map((r) => r.source)).toEqual(['config']);
  });

  it('refuses a config save without an entry and a file save without raw', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });
    expect(() => prompts.save({ name: 'x', scope: 'global', source: 'config' }, workspace)).toThrow(/structured entry/);
    expect(() => prompts.save({ name: 'x', scope: 'global', source: 'file' }, workspace)).toThrow(/raw markdown/);
  });

  it('edits the injected config dir, never the XDG one', () => {
    // A bot passes its own tree; the host's XDG_CONFIG_HOME must stay untouched
    // even though a host-wide shell would resolve there.
    const decoy = join(root, 'xdg-decoy');
    const previous = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = decoy;
    try {
      const prompts = new OpenCodePrompts({ configDir: globalBase });
      prompts.save({ name: 'scoped', scope: 'global', raw: composeCommandFile('S', '\nBody\n') }, workspace);

      const listed = prompts.list(workspace);
      expect(listed.globalDir).toBe(join(globalBase, 'commands'));
      expect(listed.configPath).toBe(join(globalBase, 'opencode.json'));
      expect(existsSync(join(globalBase, 'commands', 'scoped.md'))).toBe(true);
      expect(existsSync(decoy)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env['XDG_CONFIG_HOME'];
      } else {
        process.env['XDG_CONFIG_HOME'] = previous;
      }
    }
  });

  it('reports a JSONC config issue while still listing its commands', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });
    mkdirSync(globalBase, { recursive: true });
    writeFileSync(
      join(globalBase, 'opencode.json'),
      '{\n  // note\n  "command": { "cfg": { "template": "Body" } },\n}\n',
      'utf8',
    );

    const listed = prompts.list(workspace);

    expect(listed.templates.find((t) => t.name === 'cfg')?.source).toBe('config');
    expect(listed.issues.find((issue) => issue.code === 'normalize')).toMatchObject({
      file: join(globalBase, 'opencode.json'),
      code: 'normalize',
      fixable: true,
    });
  });

  it('answers a refused config save instead of throwing', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });

    const refused = prompts.save(
      { name: 'x', scope: 'global', source: 'config', entry: { template: '' } },
      workspace,
    );

    expect(refused.ok).toBe(false);
    expect(refused.source).toBe('config');
    expect(refused.message).toMatch(/needs a "template"/);
    expect(existsSync(join(globalBase, 'opencode.json'))).toBe(false);
  });

  it('fingerprints the commands of a directory', () => {
    const prompts = new OpenCodePrompts({ configDir: globalBase });
    const before = prompts.configSignature(workspace);
    expect(prompts.configSignature(workspace)).toBe(before);

    prompts.save(
      { name: 'sig', scope: 'global', raw: composeCommandFile(undefined, '\nB\n') },
      workspace,
    );

    expect(prompts.configSignature(workspace)).not.toBe(before);
  });

  it('writes a bot tree a private command file', () => {
    // A bot's tree is Morse's own: a file it creates is private from the moment
    // it exists, not the 0644 a user-owned write leaves behind. The XDG dir is
    // redirected too, so a regression writes inside this test's temp tree rather
    // than the developer's own `~/.config/opencode`.
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
    const botRoot = join(root, 'bots', 'news-finder', 'config');
    const prompts = new OpenCodePrompts({ ownership: 'isolated', root: botRoot });

    expect(
      prompts.save(
        { name: 'bot', scope: 'global', raw: composeCommandFile('B', '\nBody\n') },
        workspace,
      ),
    ).toMatchObject({ ok: true, source: 'file' });

    expect(statSync(join(botRoot, 'opencode', 'commands', 'bot.md')).mode & 0o777).toBe(0o600);
    vi.unstubAllEnvs();
  });
});
