import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiPrompts, isValidTemplateName, parsePromptTemplateInput } from './pi-prompts.js';
import { writeProjectTrust } from './internal/project-trust.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'morse-prompts-'));
  roots.push(root);
  return root;
}

/** A global prompt directory with one template already in it. */
async function withGlobal(agentDir: string): Promise<void> {
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  writeFileSync(join(agentDir, 'prompts', 'review.md'), '---\ndescription: Review\n---\nReview it.\n');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PiPrompts.list', () => {
  it('reads the user prompts and reports where a save would go', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    await withGlobal(agentDir);
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.list(cwd);

    expect(result.globalDir).toBe(join(agentDir, 'prompts'));
    expect(result.projectDir).toBe(join(cwd, '.pi', 'prompts'));
    expect(result.trusted).toBe(false);
    expect(result.templates).toEqual([
      expect.objectContaining({
        name: 'review',
        scope: 'global',
        description: 'Review',
        body: 'Review it.',
      }),
    ]);
  });

  it('lets a project template shadow a user one with the same name', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    await withGlobal(agentDir);
    mkdirSync(join(cwd, '.pi', 'prompts'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'prompts', 'review.md'), 'Project review.\n');
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.list(cwd);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toMatchObject({ name: 'review', scope: 'project', body: 'Project review.' });
  });

  it('reports the frontmatter error instead of dropping a broken file', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    mkdirSync(join(agentDir, 'prompts'), { recursive: true });
    writeFileSync(join(agentDir, 'prompts', 'broken.md'), '---\nkey: "unterminated\n---\nbody\n');
    const prompts = new PiPrompts({ agentDir });

    const template = prompts.list(cwd).templates[0];

    expect(template.name).toBe('broken');
    expect(template.error).toBeDefined();
    expect(template.raw).toContain('unterminated');
  });

  it('marks the project trusted after a trust decision', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeProjectTrust(cwd, agentDir);
    const prompts = new PiPrompts({ agentDir });

    expect(prompts.list(cwd).trusted).toBe(true);
  });

  it('lists only the user prompts when no project directory is given', async () => {
    const agentDir = await tempRoot();
    await withGlobal(agentDir);
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.list('');

    expect(result.projectDir).toBe('');
    expect(result.trusted).toBe(false);
    expect(result.templates.map((template) => template.name)).toEqual(['review']);
  });
});

describe('PiPrompts.save', () => {
  it('writes a new user template with a trailing newline', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.save(
      { name: 'fix', scope: 'global', raw: '---\ndescription: Fix\n---\nFix $1.' },
      cwd,
    );

    expect(result).toEqual({ ok: true, path: join(agentDir, 'prompts', 'fix.md'), scope: 'global' });
    expect(readFileSync(join(agentDir, 'prompts', 'fix.md'), 'utf8')).toBe(
      '---\ndescription: Fix\n---\nFix $1.\n',
    );
  });

  it('writes a project template even before the project is trusted', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.save({ name: 'local', scope: 'project', raw: 'Local only.' }, cwd);

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, '.pi', 'prompts', 'local.md'))).toBe(true);
  });

  it('removes the old file when a rename moves it', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    await withGlobal(agentDir);
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.save(
      { originalName: 'review', originalScope: 'global', name: 'review-staged', scope: 'global', raw: 'New.' },
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(agentDir, 'prompts', 'review.md'))).toBe(false);
    expect(existsSync(join(agentDir, 'prompts', 'review-staged.md'))).toBe(true);
  });

  it('refuses a project save when there is no project directory', async () => {
    const agentDir = await tempRoot();
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.save({ name: 'fix', scope: 'project', raw: 'Fix it.' }, '');

    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
  });

  it('refuses a name that could escape the prompt directory', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.save({ name: '../evil', scope: 'global', raw: 'x' }, cwd);

    expect(result.ok).toBe(false);
    expect(existsSync(join(agentDir, 'evil.md'))).toBe(false);
  });

  it('refuses frontmatter pi would not load', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.save({ name: 'bad', scope: 'global', raw: '---\nkey: "oops\n---\nbody' }, cwd);

    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
    expect(existsSync(join(agentDir, 'prompts', 'bad.md'))).toBe(false);
  });
});

describe('PiPrompts.delete', () => {
  it('removes the file from its scope', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    await withGlobal(agentDir);
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.delete('review', 'global', cwd);

    expect(result.ok).toBe(true);
    expect(existsSync(join(agentDir, 'prompts', 'review.md'))).toBe(false);
  });

  it('refuses a name that is not there', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const prompts = new PiPrompts({ agentDir });

    const result = prompts.delete('missing', 'project', cwd);

    expect(result).toEqual({
      ok: false,
      message: '"missing" is not defined in this project\'s .pi/prompts.',
    });
  });
});

describe('isValidTemplateName', () => {
  it('accepts an ordinary command name', () => {
    expect(isValidTemplateName('review-staged')).toBe(true);
    expect(isValidTemplateName('a.b')).toBe(true);
  });

  it('rejects a path or an empty name', () => {
    expect(isValidTemplateName('../x')).toBe(false);
    expect(isValidTemplateName('a/b')).toBe(false);
    expect(isValidTemplateName('')).toBe(false);
  });
});

describe('parsePromptTemplateInput', () => {
  it('normalises a wire payload', () => {
    expect(
      parsePromptTemplateInput({ name: ' fix ', scope: 'project', raw: 'body', originalName: 'old' }),
    ).toEqual({ name: 'fix', scope: 'project', raw: 'body', originalName: 'old' });
  });

  it('defaults to global and drops junk', () => {
    expect(parsePromptTemplateInput({ name: 3, scope: 'nope', raw: null })).toEqual({
      name: '',
      scope: 'global',
      raw: '',
    });
  });
});
