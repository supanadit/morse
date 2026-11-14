import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveEngineContext } from '@morse/engine-config';
import { afterEach, describe, expect, it } from 'vitest';

import { writeProjectTrust } from '../internal/project-trust.js';
import { PiEngineDefinition, type PiEngineInstance } from './pi-engine.js';
import { PiPromptStore } from './pi-prompt-store.js';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-pi-prompts-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  cwd: string;
  instance: PiEngineInstance;
  prompts: PiPromptStore;
  globalDir: string;
  projectDir: string;
}

const engine = new PiEngineDefinition();

/** A user engine over two temp roots, with the prompt directories named. */
function fixture(): Fixture {
  const home = root();
  const cwd = root();
  const instance = engine.create(resolveEngineContext({ ownership: 'user', home, cwd, env: {} }));
  const prompts = instance.prompts;
  if (!(prompts instanceof PiPromptStore)) {
    throw new Error('a pi engine must supply its prompt store');
  }
  return {
    home,
    cwd,
    instance,
    prompts,
    globalDir: join(home, '.pi', 'agent', 'prompts'),
    projectDir: join(cwd, '.pi', 'prompts'),
  };
}

function seed(dir: string, name: string, raw: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, raw, 'utf8');
  return path;
}

/** Record a "do not load" decision for one directory in pi's trust file. */
function denyTrust(dir: string, agentDir: string): void {
  const path = join(agentDir, 'trust.json');
  const decisions = JSON.parse(readFileSync(path, 'utf8')) as Record<string, boolean | null>;
  decisions[realpathSync(dir)] = false;
  writeFileSync(path, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
}

describe('PiPromptStore.dirs', () => {
  it('resolves the user and project prompt directories', () => {
    const { prompts, cwd, globalDir, projectDir } = fixture();

    expect(prompts.dirs(cwd)).toEqual({ global: globalDir, project: projectDir });
    expect(prompts.dirs()).toEqual({ global: globalDir });
    expect(prompts.extension).toBe('md');
  });
});

describe('PiPromptStore.list', () => {
  it('decodes a template and reports where a save would go', () => {
    const { prompts, cwd, globalDir, projectDir } = fixture();
    const raw = '---\ndescription: Review\nargument-hint: "[file]"\n---\nReview it.\n';
    seed(globalDir, 'review', raw);

    const listed = prompts.list(cwd);

    expect(listed.issues).toEqual([]);
    expect(listed.globalDir).toBe(globalDir);
    expect(listed.projectDir).toBe(projectDir);
    expect(listed.trusted).toBe(false);
    expect(listed.items).toEqual([
      {
        name: 'review',
        scope: 'global',
        source: 'file',
        path: join(globalDir, 'review.md'),
        description: 'Review',
        argumentHint: '[file]',
        body: 'Review it.',
        raw: '---\ndescription: Review\nargument-hint: "[file]"\n---\nReview it.\n',
      },
    ]);
  });

  it('lets a project template shadow a user one with the same name', () => {
    const { prompts, cwd, globalDir, projectDir } = fixture();
    seed(globalDir, 'review', 'User review.\n');
    seed(projectDir, 'review', 'Project review.\n');

    const listed = prompts.list(cwd);

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      name: 'review',
      scope: 'project',
      body: 'Project review.',
    });
  });

  it('lists only the user templates when no project is open', () => {
    const { prompts, globalDir, projectDir } = fixture();
    seed(globalDir, 'review', 'User review.\n');
    seed(projectDir, 'review', 'Project review.\n');

    const listed = prompts.list();

    expect(listed.projectDir).toBeUndefined();
    expect(listed.items.map((item) => item.name)).toEqual(['review']);
    expect(listed.items[0]).toMatchObject({ scope: 'global', body: 'User review.' });
  });

  it('keeps a broken file listed with the frontmatter error', () => {
    const { prompts, cwd, globalDir } = fixture();
    seed(globalDir, 'broken', '---\nkey: "unterminated\n---\nbody\n');

    const listed = prompts.list(cwd);

    expect(listed.issues).toEqual([]);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.name).toBe('broken');
    expect(listed.items[0]!.error).toContain('Missing closing');
    expect(listed.items[0]!.raw).toContain('unterminated');
  });

  it('mirrors the project trust file, and reports no project as untrusted', () => {
    const { prompts, cwd, home } = fixture();

    expect(prompts.list(cwd).trusted).toBe(false);
    expect(prompts.list().trusted).toBe(false);

    writeProjectTrust(cwd, join(home, '.pi', 'agent'));

    expect(prompts.list(cwd).trusted).toBe(true);
    expect(prompts.list().trusted).toBe(false);
  });

  it('reads trust at the project root even when .pi/prompts is a symlink outside it', () => {
    const { prompts, cwd, home, projectDir } = fixture();
    const outside = root();
    writeProjectTrust(cwd, join(home, '.pi', 'agent'));
    mkdirSync(dirname(projectDir), { recursive: true });
    symlinkSync(outside, projectDir, 'dir');

    expect(prompts.list(cwd).trusted).toBe(true);
  });

  it('ignores a false entry on .pi when the project root is trusted', () => {
    const { prompts, cwd, home, projectDir } = fixture();
    const agentDir = join(home, '.pi', 'agent');
    mkdirSync(projectDir, { recursive: true });
    writeProjectTrust(cwd, agentDir);
    denyTrust(join(cwd, '.pi'), agentDir);

    expect(prompts.list(cwd).trusted).toBe(true);
  });
});

describe('PiPromptStore.save', () => {
  it('writes the raw text with a trailing newline', () => {
    const { prompts, cwd, globalDir } = fixture();

    const result = prompts.save(
      { name: 'fix', scope: 'global', raw: '---\ndescription: Fix\n---\nFix $1.' },
      'global',
      cwd,
    );

    expect(result).toMatchObject({ ok: true, path: join(globalDir, 'fix.md'), scope: 'global' });
    expect(readFileSync(join(globalDir, 'fix.md'), 'utf8')).toBe(
      '---\ndescription: Fix\n---\nFix $1.\n',
    );
  });

  it('writes the new file and deletes the old one on a scope move', () => {
    const { prompts, cwd, globalDir, projectDir } = fixture();
    seed(globalDir, 'review', 'User review.\n');

    const result = prompts.save(
      {
        originalName: 'review',
        originalScope: 'global',
        name: 'review',
        scope: 'project',
        raw: 'Project review.',
      },
      'project',
      cwd,
    );

    expect(result).toMatchObject({
      ok: true,
      path: join(projectDir, 'review.md'),
      scope: 'project',
    });
    expect(readFileSync(join(projectDir, 'review.md'), 'utf8')).toBe('Project review.\n');
    expect(existsSync(join(globalDir, 'review.md'))).toBe(false);
  });

  it('refuses frontmatter pi would not load, with pi’s own message', () => {
    const { prompts, cwd, globalDir } = fixture();

    const result = prompts.save(
      { name: 'bad', scope: 'global', raw: '---\nkey: "oops\n---\nbody' },
      'global',
      cwd,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Missing closing');
    expect(existsSync(join(globalDir, 'bad.md'))).toBe(false);
  });

  it('refuses a project save when no project is open', () => {
    const { prompts } = fixture();

    const result = prompts.save({ name: 'fix', scope: 'project', raw: 'Fix it.' }, 'project');

    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
  });

  it('refuses a name that could escape the prompt directory', () => {
    const { prompts, cwd, home } = fixture();

    const result = prompts.save({ name: '../evil', scope: 'global', raw: 'x' }, 'global', cwd);

    expect(result.ok).toBe(false);
    expect(existsSync(join(home, '.pi', 'agent', 'evil.md'))).toBe(false);
  });
});

describe('PiPromptStore.remove', () => {
  it('removes only the named template', () => {
    const { prompts, cwd, globalDir } = fixture();
    seed(globalDir, 'one', 'One.\n');
    seed(globalDir, 'two', 'Two.\n');

    const result = prompts.remove('one', 'global', cwd);

    expect(result).toMatchObject({ ok: true, path: join(globalDir, 'one.md'), scope: 'global' });
    expect(existsSync(join(globalDir, 'one.md'))).toBe(false);
    expect(existsSync(join(globalDir, 'two.md'))).toBe(true);
  });

  it('refuses a name that is not there, naming its directory', () => {
    const { prompts, cwd, projectDir } = fixture();

    const result = prompts.remove('missing', 'project', cwd);

    expect(result.ok).toBe(false);
    expect(result.message).toBe(`No prompt named "missing" is defined in ${projectDir}.`);
  });

  it('never touches a project directory from an isolated tree', () => {
    const isolatedRoot = root();
    const cwd = root();
    const bot = engine.isolated(isolatedRoot, { home: root(), env: {} });
    const prompts = bot.prompts;

    expect(prompts.dirs(cwd)).toEqual({ global: join(isolatedRoot, 'prompts') });
    expect(prompts.list(cwd).projectDir).toBeUndefined();

    const result = prompts.save({ name: 'fix', scope: 'project', raw: 'Fix.' }, 'project', cwd);
    expect(result.ok).toBe(false);
    expect(existsSync(join(cwd, '.pi', 'prompts', 'fix.md'))).toBe(false);
  });
});
