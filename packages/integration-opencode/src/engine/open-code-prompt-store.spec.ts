import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEngineContext, type ConfigIssue } from '@morse/engine-config';
import { afterEach, describe, expect, it } from 'vitest';

import { composeCommandFile, parseCommandFile } from '../internal/opencode-prompts-config.js';
import { OpenCodeCommandSection } from './open-code-command-section.js';
import { OpenCodeEngineDefinition, type OpenCodeEngineInstance } from './open-code-engine.js';
import { OpenCodeFilePromptStore, OpenCodePromptStore } from './open-code-prompt-store.js';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-oc-prompts-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  cwd: string;
  configDir: string;
  instance: OpenCodeEngineInstance;
  prompts: OpenCodePromptStore;
  globalDir: string;
  projectDir: string;
  configPath: string;
}

const definition = (configDir: string) => new OpenCodeEngineDefinition({ configDir });

/** A user engine over two temp roots, with the command directories named. */
function fixture(): Fixture {
  const home = root();
  const cwd = root();
  const configDir = join(home, '.config', 'opencode');
  const instance = definition(configDir).create(
    resolveEngineContext({ ownership: 'user', home, cwd, env: {} }),
  );
  return {
    home,
    cwd,
    configDir,
    instance,
    prompts: instance.prompts,
    globalDir: join(configDir, 'commands'),
    projectDir: join(cwd, '.opencode', 'commands'),
    configPath: join(configDir, 'opencode.json'),
  };
}

function seed(dir: string, name: string, raw: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, raw, 'utf8');
  return path;
}

function writeCommandConfig(configPath: string, file: unknown): void {
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

function readJson(path: string): { command?: Record<string, unknown>; [key: string]: unknown } {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    command?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

describe('OpenCodeFilePromptStore dirs', () => {
  it('resolves the global and project command directories', () => {
    const { configDir, cwd, globalDir, projectDir } = fixture();
    const files = new OpenCodeFilePromptStore({ configDir, ownership: 'user' });

    expect(files.dirs(cwd)).toEqual({ global: globalDir, project: projectDir });
    expect(files.dirs()).toEqual({ global: globalDir });
    expect(files.extension).toBe('md');
  });
});

describe('OpenCodeFilePromptStore.list', () => {
  it('lists both scopes with their fields and paths', () => {
    const { prompts, cwd, globalDir, projectDir } = fixture();
    seed(globalDir, 'greet', '---\ndescription: Say hi\n---\n\nHi $ARGUMENTS\n');
    seed(projectDir, 'fix', '---\ndescription: Fix it\n---\n\nFix $1\n');

    const listed = prompts.list(cwd);

    expect(listed.issues).toEqual([]);
    expect(listed.items.map((item) => item.name)).toEqual(['greet', 'fix']);
    expect(listed.items[0]).toMatchObject({
      name: 'greet',
      scope: 'global',
      source: 'file',
      path: join(globalDir, 'greet.md'),
      description: 'Say hi',
      body: '\n\nHi $ARGUMENTS\n',
    });
    expect(listed.items[1]).toMatchObject({
      name: 'fix',
      scope: 'project',
      source: 'file',
      description: 'Fix it',
      raw: '---\ndescription: Fix it\n---\n\nFix $1\n',
    });
  });

  it('lists a global and a project row of the same name (no shadowing)', () => {
    const { prompts, cwd, globalDir, projectDir } = fixture();
    seed(globalDir, 'dual', 'Global body.\n');
    seed(projectDir, 'dual', 'Project body.\n');

    const rows = prompts.list(cwd).items.filter((item) => item.name === 'dual');

    expect(rows.map((row) => row.scope)).toEqual(['global', 'project']);
    expect(rows.map((row) => row.body)).toEqual(['Global body.\n', 'Project body.\n']);
  });

  it('lists no project rows without a workspace', () => {
    const { prompts, globalDir, projectDir } = fixture();
    seed(globalDir, 'greet', 'Hi.\n');
    seed(projectDir, 'fix', 'Fix.\n');

    const listed = prompts.list();

    expect(listed.items.map((item) => item.name)).toEqual(['greet']);
  });

  it('lists a broken file with its frontmatter error instead of hiding it', () => {
    const { prompts, cwd, globalDir } = fixture();
    seed(globalDir, 'broken', '---\ndescription: never closed\n');

    const broken = prompts.list(cwd).items.find((item) => item.name === 'broken');

    expect(broken?.error).toMatch(/never closed/);
    expect(broken?.raw).toBe('---\ndescription: never closed\n');
  });

  it('accepts a file without frontmatter', () => {
    const { prompts, cwd, globalDir } = fixture();
    seed(globalDir, 'plain', 'Just a body.\n');

    const plain = prompts.list(cwd).items.find((item) => item.name === 'plain');

    expect(plain?.body).toBe('Just a body.\n');
    expect(plain?.description).toBeUndefined();
    expect(plain?.error).toBeUndefined();
  });
});

describe('OpenCodeFilePromptStore.save and remove', () => {
  it('writes raw verbatim, lists it, and deletes it', () => {
    const { prompts, cwd, projectDir } = fixture();
    const raw = composeCommandFile('Fresh', '\nBody\n');

    const saved = prompts.save({ name: 'fresh', scope: 'project', raw }, 'project', cwd);

    expect(saved).toMatchObject({ ok: true, path: join(projectDir, 'fresh.md'), scope: 'project' });
    expect(readFileSync(join(projectDir, 'fresh.md'), 'utf8')).toBe(raw);
    expect(prompts.list(cwd).items.find((item) => item.name === 'fresh')).toMatchObject({
      scope: 'project',
      source: 'file',
      description: 'Fresh',
    });

    const removed = prompts.remove('fresh', 'project', cwd, 'file');

    expect(removed).toMatchObject({ ok: true, path: join(projectDir, 'fresh.md') });
    expect(existsSync(join(projectDir, 'fresh.md'))).toBe(false);
  });

  it('renames by writing the new file and deleting the old one', () => {
    const { prompts, cwd, globalDir } = fixture();
    seed(globalDir, 'old', 'Old body.\n');

    const saved = prompts.save(
      {
        name: 'new',
        scope: 'global',
        originalName: 'old',
        originalScope: 'global',
        raw: 'New body.\n',
      },
      'global',
      cwd,
    );

    expect(saved.ok).toBe(true);
    expect(readFileSync(join(globalDir, 'new.md'), 'utf8')).toBe('New body.\n');
    expect(existsSync(join(globalDir, 'old.md'))).toBe(false);
  });

  it('moves between scopes, deleting the old file', () => {
    const { prompts, cwd, globalDir, projectDir } = fixture();
    seed(globalDir, 'mv', 'Moved.\n');

    const saved = prompts.save(
      {
        name: 'mv',
        scope: 'project',
        originalName: 'mv',
        originalScope: 'global',
        raw: 'Moved.\n',
      },
      'project',
      cwd,
    );

    expect(saved).toMatchObject({ ok: true, path: join(projectDir, 'mv.md') });
    expect(existsSync(join(globalDir, 'mv.md'))).toBe(false);
  });

  it('refuses a name that could escape the command directory', () => {
    const { prompts, cwd } = fixture();

    const saved = prompts.save({ name: '../evil', scope: 'global', raw: 'x' }, 'global', cwd);

    expect(saved.ok).toBe(false);
    expect(saved.message).toMatch(/valid command name/);
  });

  it('refuses frontmatter the parser cannot read instead of writing it', () => {
    const { prompts, cwd, globalDir } = fixture();

    const saved = prompts.save(
      { name: 'broken', scope: 'global', raw: '---\ndescription: never closed\n' },
      'global',
      cwd,
    );

    expect(saved.ok).toBe(false);
    expect(saved.message).toMatch(/never closed/);
    expect(existsSync(join(globalDir, 'broken.md'))).toBe(false);
  });

  it('refuses to remove a command that is not there, naming the directory', () => {
    const { prompts, cwd, projectDir } = fixture();

    const removed = prompts.remove('missing', 'project', cwd);

    expect(removed.ok).toBe(false);
    expect(removed.message).toBe(`No command named "missing" is defined in ${projectDir}.`);
  });
});

describe('OpenCodeCommandSection', () => {
  it('decodes one entry into a config row, unknown fields kept', () => {
    const section = new OpenCodeCommandSection();
    const issues: ConfigIssue[] = [];

    const row = section.decodeEntry(
      'test',
      { template: 'Run tests', description: 'Run them', agent: 'build', extra: 1 },
      {
        file: '/w/opencode.json',
        fileId: 'config',
        scope: 'global',
        issues,
        pointer: (...segments: string[]) => segments.join('/'),
      },
    );

    expect(row).toEqual({
      name: 'test',
      scope: 'global',
      source: 'config',
      description: 'Run them',
      entry: { template: 'Run tests', description: 'Run them', agent: 'build', extra: 1 },
    });
  });

  it('encodes the entry as the stored value', () => {
    const section = new OpenCodeCommandSection();

    expect(
      section.encodeEntry(
        {
          name: 'test',
          scope: 'global',
          source: 'config',
          entry: { template: 'Body', agent: 'build' },
        },
        undefined,
      ),
    ).toEqual({ template: 'Body', agent: 'build' });
  });

  it('merges the kept entry, keeping template and description authoritative', () => {
    const section = new OpenCodeCommandSection();

    const encoded = section.encodeEntry(
      {
        name: 'test',
        scope: 'global',
        source: 'config',
        entry: { template: 'New body' },
      },
      { template: 'Old body', description: 'Old', agent: 'build', subtask: true, extra: 'kept' },
    );

    expect(encoded).toEqual({
      template: 'New body',
      agent: 'build',
      subtask: true,
      extra: 'kept',
    });
  });

  it('refuses an entry without a template and a save without an entry', () => {
    const section = new OpenCodeCommandSection();
    const issues: ConfigIssue[] = [];
    const context = {
      file: '/w/opencode.json',
      fileId: 'config',
      scope: 'global' as const,
      issues,
      pointer: (...segments: string[]) => segments.join('/'),
    };

    expect(section.decodeEntry('bad', { description: 'no template' }, context)).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(() =>
      section.encodeEntry({ name: 'bad', scope: 'global', source: 'config' }, undefined),
    ).toThrow(/structured "entry"/);
    expect(() =>
      section.encodeEntry(
        { name: 'bad', scope: 'global', source: 'config', entry: { template: '' } },
        undefined,
      ),
    ).toThrow(/needs a "template"/);
  });
});

describe('OpenCodeConfigPromptStore', () => {
  it('lists command-key entries as source config, scope global', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, {
      $schema: 'https://opencode.ai/config.json',
      command: {
        test: { template: 'Run tests', description: 'Run them', agent: 'build' },
      },
    });

    const row = prompts.list(cwd).items.find((item) => item.name === 'test');

    expect(row).toMatchObject({ name: 'test', source: 'config', scope: 'global' });
    expect(row?.entry).toEqual({ template: 'Run tests', description: 'Run them', agent: 'build' });
    expect(row?.description).toBe('Run them');
  });

  it('skips an invalid entry with a pointer and lists its siblings', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, {
      command: {
        good: { template: 'Keep me' },
        bad: { description: 'no template' },
        alsoGood: { template: 'Me too' },
      },
    });

    const listed = prompts.list(cwd);

    expect(listed.items.map((item) => item.name)).toEqual(['good', 'alsoGood']);
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({
      code: 'shape',
      pointer: '/command/bad',
      file: configPath,
      fileId: 'config',
      scope: 'global',
    });
    expect(listed.issues[0]!.message).toMatch(/string "template"/);
  });

  it('reports a command block that is not an object, and lists no entries', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, { command: ['nope'] });

    const listed = prompts.list(cwd);

    expect(listed.items).toEqual([]);
    expect(listed.issues[0]).toMatchObject({ code: 'shape', pointer: '/command' });
    expect(listed.issues[0]!.message).toMatch(/must be an object/);
  });

  it('lists nothing for a missing config file', () => {
    const { prompts, cwd } = fixture();

    expect(prompts.list(cwd)).toMatchObject({ items: [], issues: [] });
  });

  it('upserts one entry, keeping every sibling and top-level key', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, {
      $schema: 'https://opencode.ai/config.json',
      model: 'acme/one',
      command: { keep: { template: 'Keep me', extra: { nested: true } } },
    });

    const saved = prompts.save(
      {
        name: 'added',
        scope: 'global',
        source: 'config',
        entry: { template: 'Body', description: 'Added' },
      },
      'global',
      cwd,
    );

    expect(saved).toMatchObject({ ok: true, path: configPath, scope: 'global' });
    const file = readJson(configPath);
    expect(file['$schema']).toBe('https://opencode.ai/config.json');
    expect(file['model']).toBe('acme/one');
    expect(file['command']).toEqual({
      keep: { template: 'Keep me', extra: { nested: true } },
      added: { template: 'Body', description: 'Added' },
    });
  });

  it('renames by deleting the old key and inserting the new one', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, { command: { old: { template: 'Old' } } });

    const saved = prompts.save(
      {
        name: 'new',
        scope: 'global',
        source: 'config',
        originalName: 'old',
        originalSource: 'config',
        entry: { template: 'New' },
      },
      'global',
      cwd,
    );

    expect(saved.ok).toBe(true);
    expect(readJson(configPath)['command']).toEqual({ new: { template: 'New' } });
  });

  it('removes a renamed key from the json fallback while the jsonc is the write target', () => {
    const { prompts, cwd, configDir } = fixture();
    const jsonc = join(configDir, 'opencode.jsonc');
    const json = join(configDir, 'opencode.json');
    writeCommandConfig(jsonc, { command: { keep: { template: 'Keep' } } });
    writeCommandConfig(json, { command: { old: { template: 'Old', agent: 'build' } } });

    const saved = prompts.save(
      {
        name: 'new',
        scope: 'global',
        source: 'config',
        originalName: 'old',
        originalSource: 'config',
        entry: { template: 'New' },
      },
      'global',
      cwd,
    );

    expect(saved).toMatchObject({ ok: true, path: jsonc });
    expect(readJson(jsonc)['command']).toEqual({
      keep: { template: 'Keep' },
      new: { template: 'New' },
    });
    expect(readJson(json)['command']).toBeUndefined();
  });

  it('refuses a rename when a fallback file might still define the old key', () => {
    const { prompts, cwd, configDir } = fixture();
    const jsonc = join(configDir, 'opencode.jsonc');
    const json = join(configDir, 'opencode.json');
    writeCommandConfig(jsonc, { command: { keep: { template: 'Keep' } } });
    // A corrupt fallback cannot prove the old key is gone, so the rename may not
    // report success while it might still answer `/old`.
    mkdirSync(configDir, { recursive: true });
    writeFileSync(json, '{ "command": ', 'utf8');

    const saved = prompts.save(
      {
        name: 'new',
        scope: 'global',
        source: 'config',
        originalName: 'old',
        originalSource: 'config',
        entry: { template: 'New' },
      },
      'global',
      cwd,
    );

    expect(saved.ok).toBe(false);
    expect(saved.path).toBe(json);
    expect(saved.issues[0]).toMatchObject({ code: 'parse', file: json });
    expect(readJson(jsonc)['command']).toEqual({
      keep: { template: 'Keep' },
      new: { template: 'New' },
    });
  });

  it('deletes a command defined in the json fallback', () => {
    const { prompts, cwd, configDir } = fixture();
    const jsonc = join(configDir, 'opencode.jsonc');
    const json = join(configDir, 'opencode.json');
    writeCommandConfig(jsonc, { command: { keep: { template: 'Keep' } } });
    writeCommandConfig(json, { command: { extra: { template: 'Extra' } } });

    const removed = prompts.remove('extra', 'global', cwd, 'config');

    expect(removed).toMatchObject({ ok: true, path: json });
    expect(readJson(json)['command']).toBeUndefined();
    expect(readJson(jsonc)['command']).toEqual({ keep: { template: 'Keep' } });
  });

  it('keeps the fields the editor does not send when an entry is saved', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, {
      command: {
        build: { template: 'Old body', description: 'Old', agent: 'build', subtask: true },
      },
    });

    const saved = prompts.save(
      { name: 'build', scope: 'global', source: 'config', entry: { template: 'New body' } },
      'global',
      cwd,
    );

    expect(saved.ok).toBe(true);
    expect(readJson(configPath)['command']).toEqual({
      build: { template: 'New body', agent: 'build', subtask: true },
    });
  });

  it('replaces the description the editor sends', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, {
      command: { build: { template: 'Body', description: 'Old', agent: 'build' } },
    });

    prompts.save(
      {
        name: 'build',
        scope: 'global',
        source: 'config',
        entry: { template: 'Body', description: 'New' },
      },
      'global',
      cwd,
    );

    expect(readJson(configPath)['command']).toEqual({
      build: { template: 'Body', description: 'New', agent: 'build' },
    });
  });

  it('removes one entry, and the block once it empties', () => {
    const { prompts, cwd, configPath } = fixture();
    writeCommandConfig(configPath, { command: { one: { template: 'One' } }, theme: 'dark' });

    expect(prompts.remove('one', 'global', cwd, 'config').ok).toBe(true);
    const file = readJson(configPath);
    expect(file['command']).toBeUndefined();
    expect(file['theme']).toBe('dark');
  });

  it('refuses an empty template and an invalid name', () => {
    const { prompts, cwd, configPath } = fixture();

    const empty = prompts.save(
      { name: 'ok', scope: 'global', source: 'config', entry: { template: '' } },
      'global',
      cwd,
    );
    expect(empty.ok).toBe(false);
    expect(empty.issues[0]!.message).toMatch(/needs a "template"/);
    expect(existsSync(configPath)).toBe(false);

    const named = prompts.save(
      { name: 'bad name', scope: 'global', source: 'config', entry: { template: 'x' } },
      'global',
      cwd,
    );
    expect(named.ok).toBe(false);
    expect(named.issues[0]!.message).toMatch(/valid command name/);
  });

  it('refuses a store save without an entry, and lists a non-object entry as an issue', () => {
    const { prompts, cwd, configPath } = fixture();

    const missing = prompts.save({ name: 'cfg', scope: 'global', source: 'config' }, 'global', cwd);
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]!.message).toMatch(/structured "entry"/);

    writeCommandConfig(configPath, { command: { bad: 'not an object' } });
    const listed = prompts.list(cwd);
    expect(listed.items).toEqual([]);
    expect(listed.issues[0]).toMatchObject({ code: 'shape', pointer: '/command/bad' });
  });
});

describe('OpenCodePromptStore', () => {
  it('lists file rows then config rows, with the directories and config path', () => {
    const { prompts, cwd, globalDir, projectDir, configPath } = fixture();
    seed(globalDir, 'fromFile', 'File body.\n');
    writeCommandConfig(configPath, { command: { fromConfig: { template: 'Config body' } } });

    const listed = prompts.list(cwd);

    expect(listed.items.map((item) => item.source)).toEqual(['file', 'config']);
    expect(listed.globalDir).toBe(globalDir);
    expect(listed.projectDir).toBe(projectDir);
    expect(listed.trusted).toBe(true);
    expect(listed.configPath).toBe(configPath);
    expect(listed.issues).toEqual([]);
  });

  it('saves to files by default and routes a config save by source', () => {
    const { prompts, cwd, globalDir, configPath } = fixture();

    const file = prompts.save({ name: 'plain', scope: 'global', raw: 'Body.\n' }, 'global', cwd);
    expect(file).toMatchObject({ ok: true, path: join(globalDir, 'plain.md') });

    const config = prompts.save(
      {
        name: 'cfg',
        scope: 'global',
        source: 'config',
        entry: { template: 'Body', agent: 'build' },
      },
      'global',
      cwd,
    );
    expect(config).toMatchObject({ ok: true, path: configPath });

    const rows = prompts.list(cwd).items;
    expect(rows.find((item) => item.name === 'plain')?.source).toBe('file');
    expect(rows.find((item) => item.name === 'cfg')?.entry?.agent).toBe('build');
  });

  it('routes a remove by source and keeps a same-named row on the other surface', () => {
    const { prompts, cwd, globalDir, configPath } = fixture();
    seed(globalDir, 'dual', 'File body.\n');
    writeCommandConfig(configPath, { command: { dual: { template: 'Config body' } } });

    expect(prompts.list(cwd).items.filter((item) => item.name === 'dual')).toHaveLength(2);

    expect(prompts.remove('dual', 'global', cwd, 'file').ok).toBe(true);
    const afterFile = prompts.list(cwd).items.filter((item) => item.name === 'dual');
    expect(afterFile.map((item) => item.source)).toEqual(['config']);

    expect(prompts.remove('dual', 'global', cwd, 'config').ok).toBe(true);
    expect(prompts.list(cwd).items.some((item) => item.name === 'dual')).toBe(false);
  });

  it('reads a JSONC config, reports a fixable issue, and refuses a write until fixed', () => {
    const { prompts, cwd, configPath, instance } = fixture();
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(
      configPath,
      '{\n  // a comment\n  "command": { "test": { "template": "Run tests" } },\n}\n',
      'utf8',
    );

    const listed = prompts.list(cwd);
    expect(listed.items.map((item) => item.name)).toEqual(['test']);
    const issue = listed.issues.find((entry) => entry.code === 'normalize');
    expect(issue).toMatchObject({ file: configPath, code: 'normalize', fixable: true });

    const before = readFileSync(configPath, 'utf8');
    const refused = prompts.save(
      { name: 'added', scope: 'global', source: 'config', entry: { template: 'Body' } },
      'global',
      cwd,
    );
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'normalize', fixable: true });
    expect(readFileSync(configPath, 'utf8')).toBe(before);

    expect(instance.file('config', 'global').normalize().ok).toBe(true);
    const retried = prompts.save(
      { name: 'added', scope: 'global', source: 'config', entry: { template: 'Body' } },
      'global',
      cwd,
    );
    expect(retried.ok).toBe(true);
    expect(readJson(configPath)['command']).toEqual({
      test: { template: 'Run tests' },
      added: { template: 'Body' },
    });
  });

  it('names the jsonc file as the config path when it is the one OpenCode reads', () => {
    const { prompts, cwd, configDir } = fixture();
    const jsonc = join(configDir, 'opencode.jsonc');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(jsonc, '{ "command": { "one": { "template": "One" } } }\n', 'utf8');

    expect(prompts.list(cwd).configPath).toBe(jsonc);
  });

  it('reflects a file and a config change in its signature, and is stable otherwise', () => {
    const { prompts, cwd, globalDir, configPath } = fixture();
    const before = prompts.signature(cwd);
    expect(prompts.signature(cwd)).toBe(before);

    seed(globalDir, 'greet', 'hi\n');
    const withFile = prompts.signature(cwd);
    expect(withFile).not.toBe(before);

    writeCommandConfig(configPath, { command: { one: { template: 'One' } } });
    expect(prompts.signature(cwd)).not.toBe(withFile);
  });
});

describe('OpenCodeEngineInstance.prompts', () => {
  it('exposes the composite prompt store', () => {
    const { instance } = fixture();

    expect(instance.prompts).toBeInstanceOf(OpenCodePromptStore);
  });

  it('reads a bot command template from its own config dir, never the host XDG one', () => {
    const botRoot = root();
    const home = root();
    const cwd = root();
    const bot = definition(join(botRoot, 'config', 'opencode')).create(
      resolveEngineContext({ ownership: 'user', home, cwd, env: {} }),
    );
    const botDir = join(botRoot, 'config', 'opencode', 'commands');
    seed(botDir, 'init', 'Bot body for $1.\n');
    // The decoy stands in for the host's XDG tree; listing it would prove the
    // leak this pins shut.
    seed(join(home, '.config', 'opencode', 'commands'), 'hostOnly', 'Host body.\n');

    const listed = bot.prompts.list(cwd);

    expect(listed.globalDir).toBe(botDir);
    expect(listed.items.map((item) => item.name)).toEqual(['init']);
    expect(parseCommandFile(listed.items[0]!.raw!).body).toBe('Bot body for $1.\n');
  });
});
