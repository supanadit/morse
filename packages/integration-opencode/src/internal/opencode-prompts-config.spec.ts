import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commandSignature,
  composeCommandFile,
  listCommands,
  moveConfigCommand,
  parseCommandFile,
  readConfigCommands,
  removeCommandFile,
  removeCommandFile as deleteCommandFile,
  upsertConfigCommand,
  writeCommandFile,
} from './opencode-prompts-config.js';

let root: string;
let globalDirBase: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-commands-'));
  globalDirBase = join(root, 'xdg', 'opencode');
  workspace = join(root, 'ws');
  mkdirSync(join(globalDirBase, 'commands'), { recursive: true });
  mkdirSync(join(workspace, '.opencode', 'commands'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeGlobal = (name: string, raw: string) =>
  writeFileSync(join(globalDirBase, 'commands', `${name}.md`), raw, 'utf8');
const writeProject = (name: string, raw: string) =>
  writeFileSync(join(workspace, '.opencode', 'commands', `${name}.md`), raw, 'utf8');
const writeConfig = (file: unknown) =>
  writeFileSync(join(globalDirBase, 'opencode.json'), JSON.stringify(file, null, 2), 'utf8');

const list = () => listCommands(workspace, globalDirBase);

describe('parseCommandFile / composeCommandFile', () => {
  it('splits frontmatter and body, and composes them back', () => {
    const raw = '---\ndescription: Run tests\n---\nRun the suite with $ARGUMENTS.\n';
    const parsed = parseCommandFile(raw);
    expect(parsed.frontmatter['description']).toBe('Run tests');
    expect(parsed.body).toBe('\nRun the suite with $ARGUMENTS.\n');
    expect(composeCommandFile('Run tests', parsed.body)).toBe(raw);
  });

  it('accepts a file without frontmatter and rejects an unclosed one', () => {
    expect(parseCommandFile('Just a body.\n').body).toBe('Just a body.\n');
    expect(() => parseCommandFile('---\ndescription: nope\n')).toThrow(/never closed/);
    expect(() => parseCommandFile('---\ngarbage line\n---\nbody')).toThrow(/no "key: value"/);
  });
});

describe('file commands', () => {
  it('lists both scopes with fields and paths', () => {
    writeGlobal('greet', '---\ndescription: Say hi\n---\n\nHi $ARGUMENTS\n');
    writeProject('fix', '---\ndescription: Fix it\n---\n\nFix $1\n');
    const { commands, globalDir, projectDir } = list();
    expect(globalDir).toBe(join(globalDirBase, 'commands'));
    expect(projectDir).toBe(join(workspace, '.opencode', 'commands'));
    const greet = commands.find((c) => c.name === 'greet');
    const fix = commands.find((c) => c.name === 'fix');
    expect(greet).toMatchObject({ scope: 'global', source: 'file', description: 'Say hi' });
    expect(greet?.body).toContain('Hi $ARGUMENTS');
    expect(fix).toMatchObject({ scope: 'project', source: 'file', description: 'Fix it' });
  });

  it('lists a broken file with its error instead of hiding it', () => {
    writeGlobal('broken', '---\ndescription: never closed\n');
    const broken = list().commands.find((c) => c.name === 'broken');
    expect(broken?.error).toMatch(/never closed/);
    expect(broken?.raw).toBeDefined();
  });

  it('writes and deletes a file command', () => {
    const raw = composeCommandFile('New command', '\nBody here.\n');
    const path = writeCommandFile(join(workspace, '.opencode', 'commands'), 'fresh', raw);
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(list().commands.some((c) => c.name === 'fresh' && c.scope === 'project')).toBe(true);
    expect(removeCommandFile(join(workspace, '.opencode', 'commands'), 'fresh')).toBe(true);
    expect(list().commands.some((c) => c.name === 'fresh')).toBe(false);
    expect(removeCommandFile(join(workspace, '.opencode', 'commands'), 'fresh')).toBe(false);
    expect(deleteCommandFile).toBe(removeCommandFile);
  });
});

describe('config commands', () => {
  it('lists command-key entries as source config', () => {
    writeConfig({
      $schema: 'https://opencode.ai/config.json',
      command: {
        test: { template: 'Run tests', description: 'Run tests with coverage', agent: 'build' },
      },
    });
    const test = list().commands.find((c) => c.name === 'test');
    expect(test).toMatchObject({ source: 'config', scope: 'global' });
    expect(test?.entry?.agent).toBe('build');
    expect(test?.description).toBe('Run tests with coverage');
  });

  it('refuses a non-object command key or an entry without a template', () => {
    writeConfig({ command: ['nope'] });
    expect(() => readConfigCommands(join(globalDirBase, 'opencode.json'))).toThrow(/must be an object/);
    writeConfig({ command: { bad: { description: 'no template' } } });
    expect(() => readConfigCommands(join(globalDirBase, 'opencode.json'))).toThrow(/string "template"/);
  });

  it('upsert touches only its entry, and rename/delete behave', () => {
    writeConfig({ command: { keep: { template: 'Keep me' } } });
    const configPath = join(globalDirBase, 'opencode.json');
    upsertConfigCommand(configPath, 'added', { template: 'Body', description: 'Added' });
    let file = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(file.command.keep).toEqual({ template: 'Keep me' });
    expect(file.command.added).toEqual({ template: 'Body', description: 'Added' });

    expect(moveConfigCommand(configPath, 'added', 'renamed')).toBe(true);
    file = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(file.command.added).toBeUndefined();
    expect(file.command.renamed).toEqual({ template: 'Body', description: 'Added' });

    expect(moveConfigCommand(configPath, 'renamed')).toBe(true);
    file = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(file.command).toEqual({ keep: { template: 'Keep me' } });

    expect(moveConfigCommand(configPath, 'keep')).toBe(true);
    file = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(file.command).toBeUndefined();
    expect(moveConfigCommand(configPath, 'ghost')).toBe(false);
  });

  it('rejects invalid names and empty templates', () => {
    const configPath = join(globalDirBase, 'opencode.json');
    expect(() => upsertConfigCommand(configPath, 'bad name', { template: 'x' })).toThrow(/valid command name/);
    expect(() => upsertConfigCommand(configPath, 'ok', { template: '' })).toThrow(/needs a "template"/);
  });
});

describe('same name in both sources', () => {
  it('lists both rows and edits never cross', () => {
    writeGlobal('dual', '---\ndescription: From file\n---\n\nFile body\n');
    writeConfig({ command: { dual: { template: 'Config body' } } });
    const rows = list().commands.filter((c) => c.name === 'dual');
    expect(rows.map((r) => r.source).sort()).toEqual(['config', 'file']);
    expect(rows.find((r) => r.source === 'file')?.body).toContain('File body');
    expect(rows.find((r) => r.source === 'config')?.entry?.template).toBe('Config body');
  });
});

describe('commandSignature', () => {
  it('moves when files or config change, and is stable otherwise', () => {
    const before = commandSignature(workspace, globalDirBase);
    expect(commandSignature(workspace, globalDirBase)).toBe(before);
    writeGlobal('greet', 'hi\n');
    expect(commandSignature(workspace, globalDirBase)).not.toBe(before);
  });
});
