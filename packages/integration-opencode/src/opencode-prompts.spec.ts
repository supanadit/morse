import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const prompts = new OpenCodePrompts();
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
    const prompts = new OpenCodePrompts();
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
    const prompts = new OpenCodePrompts();
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
    const prompts = new OpenCodePrompts();
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
    const prompts = new OpenCodePrompts();
    expect(() => prompts.save({ name: 'x', scope: 'global', source: 'config' }, workspace)).toThrow(/structured entry/);
    expect(() => prompts.save({ name: 'x', scope: 'global', source: 'file' }, workspace)).toThrow(/raw markdown/);
  });
});
