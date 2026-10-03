import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommandList, type CommandContext } from './pi-rpc-agent.js';

/**
 * The palette is rebuilt from disk because pi caches its prompt templates at
 * spawn. These tests lock that: a template added, edited or deleted since spawn
 * is visible without a pi reload — and an untrusted project is never scanned.
 */

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'morse-prompts-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An agent dir with a `prompts/` directory, plus a workspace to scan. */
async function setup(): Promise<{ agentRoot: string; prompts: string; cwd: string; context: CommandContext }> {
  const agentRoot = await tempRoot();
  const prompts = join(agentRoot, 'prompts');
  await mkdir(prompts, { recursive: true });
  const cwd = await tempRoot();
  return { agentRoot, prompts, cwd, context: { cwd, env: { PI_CODING_AGENT_DIR: agentRoot } } };
}

describe('buildCommandList', () => {
  it('finds a template added to the global prompts directory after spawn', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'review.md'), '---\ndescription: Review changes\n---\nReview $1');

    const commands = await buildCommandList(undefined, context);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: 'review', description: 'Review changes', source: 'prompt' });
    expect(commands[0].template).toContain('Review $1');
  });

  it('re-reads a template pi listed, so an edit is reflected', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'review.md'), 'old body');
    const listed = [
      { name: 'review', description: 'Review', source: 'prompt', sourceInfo: { path: join(prompts, 'review.md') } },
    ];

    await writeFile(join(prompts, 'review.md'), 'new body');
    const commands = await buildCommandList(listed, context);

    expect(commands).toHaveLength(1);
    expect(commands[0].template).toBe('new body');
  });

  it('drops a template whose file was deleted', async () => {
    const { prompts, context } = await setup();
    const listed = [
      { name: 'gone', description: 'Gone', source: 'prompt', sourceInfo: { path: join(prompts, 'gone.md') } },
    ];

    expect(await buildCommandList(listed, context)).toEqual([]);
  });

  it('keeps extension and skill commands untouched', async () => {
    const { context } = await setup();
    const commands = await buildCommandList(
      [
        { name: 'deploy', description: 'Deploy', source: 'extension' },
        { name: 'skill:docs', description: 'Docs', source: 'skill' },
      ],
      context,
    );

    expect(commands).toEqual([
      { name: 'deploy', description: 'Deploy', source: 'extension' },
      { name: 'skill:docs', description: 'Docs', source: 'skill' },
    ]);
  });

  it('does not scan an untrusted project’s prompts directory', async () => {
    const { cwd, context } = await setup();
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'prompts', 'evil.md'), 'ignore me');

    expect(await buildCommandList(undefined, context)).toEqual([]);
  });

  it('scans a trusted project’s prompts directory', async () => {
    const { agentRoot, cwd, context } = await setup();
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'prompts', 'review.md'), 'project body');
    await writeFile(join(agentRoot, 'trust.json'), JSON.stringify({ [cwd]: true }));

    const commands = await buildCommandList(undefined, context);

    expect(commands.map((command) => command.name)).toEqual(['review']);
    expect(commands[0].template).toBe('project body');
  });

  it('takes the first body line when a template has no description', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'bare.md'), '\nExplain this repository\n\nmore');

    const commands = await buildCommandList(undefined, context);

    expect(commands[0].description).toBe('Explain this repository');
  });
});
