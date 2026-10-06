import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommandList, toModelInputs, upsertStatus, upsertWidget, type CommandContext } from './pi-rpc-agent.js';

/**
 * The palette is rebuilt from disk because pi caches its prompt templates at
 * spawn. These tests lock that: a template added, edited or deleted since spawn
 * is visible without a pi reload — an untrusted project is never scanned, and a
 * template pi refuses (bad YAML frontmatter) is dropped with a diagnostic
 * instead of offered as a dead command.
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

    const { commands, diagnostics } = await buildCommandList(undefined, context);

    expect(diagnostics).toEqual([]);
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
    const { commands } = await buildCommandList(listed, context);

    expect(commands).toHaveLength(1);
    expect(commands[0].template).toBe('new body');
  });

  it('drops a template whose file was deleted', async () => {
    const { prompts, context } = await setup();
    const listed = [
      { name: 'gone', description: 'Gone', source: 'prompt', sourceInfo: { path: join(prompts, 'gone.md') } },
    ];

    expect(await buildCommandList(listed, context)).toEqual({ commands: [], diagnostics: [] });
  });

  it('keeps extension and skill commands untouched', async () => {
    const { context } = await setup();
    const { commands } = await buildCommandList(
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

    expect(await buildCommandList(undefined, context)).toEqual({ commands: [], diagnostics: [] });
  });

  it('scans a trusted project’s prompts directory', async () => {
    const { agentRoot, cwd, context } = await setup();
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'prompts', 'review.md'), 'project body');
    await writeFile(join(agentRoot, 'trust.json'), JSON.stringify({ [cwd]: true }));

    const { commands } = await buildCommandList(undefined, context);

    expect(commands.map((command) => command.name)).toEqual(['review']);
    expect(commands[0].template).toBe('project body');
  });

  it('takes the first body line when a template has no description', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'bare.md'), '\nExplain this repository\n\nmore');

    const { commands } = await buildCommandList(undefined, context);

    expect(commands[0].description).toBe('Explain this repository');
  });

  it('drops a template pi refuses and reports it, like pi’s own prompt conflicts', async () => {
    const { prompts, context } = await setup();
    // The description holds an unquoted `: `, which YAML reads as a nested
    // mapping. pi drops the template and prints a conflict; Morse must not
    // offer `/explain-path` and must say why.
    const path = join(prompts, 'explain-path.md');
    await writeFile(
      path,
      '---\ndescription: Explain a path (no argument-hint: fields come from the body)\n---\nRead $1',
    );

    const { commands, diagnostics } = await buildCommandList(undefined, context);

    expect(commands).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ key: `prompt:${path}`, level: 'warn' });
    expect(diagnostics[0].text).toContain(path);
    expect(diagnostics[0].text).toContain('Nested mappings are not allowed');
  });

  it('still lists a healthy template beside a refused one', async () => {
    const { prompts, context } = await setup();
    await writeFile(join(prompts, 'good.md'), '---\ndescription: Fine\n---\nbody');
    await writeFile(join(prompts, 'bad.md'), '---\ndescription: oops: nested\n---\nbody');

    const { commands, diagnostics } = await buildCommandList(undefined, context);

    expect(commands.map((command) => command.name)).toEqual(['good']);
    expect(diagnostics).toHaveLength(1);
  });
});

/**
 * The extension UI a frontend renders: `setWidget` and `setStatus` are
 * fire-and-forget, keyed, and per session, so applying them is a small state
 * machine — replace by key, clear when the value is gone, append otherwise.
 */
describe('upsertWidget', () => {
  it('appends a widget, defaulting to above the editor', () => {
    const widgets = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u1',
      method: 'setWidget',
      widgetKey: 'demo',
      widgetLines: ['--- Demo ---', 'line'],
    });

    expect(widgets).toEqual([
      { key: 'demo', lines: ['--- Demo ---', 'line'], placement: 'aboveEditor' },
    ]);
  });

  it('keeps pi\u2019s below-editor placement', () => {
    const widgets = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u2',
      method: 'setWidget',
      widgetKey: 'demo',
      widgetLines: ['x'],
      widgetPlacement: 'belowEditor',
    });

    expect(widgets[0]?.placement).toBe('belowEditor');
  });

  it('replaces a key in place, keeping the set order', () => {
    const first = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u3',
      method: 'setWidget',
      widgetKey: 'a',
      widgetLines: ['a1'],
    });
    const both = upsertWidget(first, {
      type: 'extension_ui_request',
      id: 'u4',
      method: 'setWidget',
      widgetKey: 'b',
      widgetLines: ['b1'],
    });

    const replaced = upsertWidget(both, {
      type: 'extension_ui_request',
      id: 'u5',
      method: 'setWidget',
      widgetKey: 'a',
      widgetLines: ['a2', 'a3'],
    });

    expect(replaced.map((widget) => widget.key)).toEqual(['a', 'b']);
    expect(replaced[0]?.lines).toEqual(['a2', 'a3']);
  });

  it('clears a widget when its lines are gone', () => {
    const set = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u6',
      method: 'setWidget',
      widgetKey: 'demo',
      widgetLines: ['x'],
    });

    expect(upsertWidget(set, {
      type: 'extension_ui_request',
      id: 'u7',
      method: 'setWidget',
      widgetKey: 'demo',
    })).toEqual([]);
  });

  it('ignores a widget without a key', () => {
    const set = upsertWidget([], {
      type: 'extension_ui_request',
      id: 'u8',
      method: 'setWidget',
      widgetLines: ['x'],
    });

    expect(set).toEqual([]);
  });
});

describe('toModelInputs', () => {
  it('keeps the modalities pi reported, in pi’s order', () => {
    expect(toModelInputs(['text', 'image'])).toEqual(['text', 'image']);
    expect(toModelInputs(['image', 'text'])).toEqual(['image', 'text']);
  });

  it('drops a value no badge exists for, so the picker cannot render a blank icon', () => {
    expect(toModelInputs(['text', 'hologram'])).toEqual(['text']);
  });

  it('keeps a text-only description as such', () => {
    expect(toModelInputs(['text'])).toEqual(['text']);
    expect(toModelInputs([])).toEqual([]);
  });
});

describe('upsertStatus', () => {
  it('sets, replaces and clears a status by key', () => {
    const a = upsertStatus([], {
      type: 'extension_ui_request',
      id: 's1',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: 'Turn 1 running',
    });
    const b = upsertStatus(a, {
      type: 'extension_ui_request',
      id: 's2',
      method: 'setStatus',
      statusKey: 'ext',
      statusText: 'Turn 1 done',
    });
    expect(b).toEqual([{ key: 'ext', text: 'Turn 1 done' }]);

    const cleared = upsertStatus(b, {
      type: 'extension_ui_request',
      id: 's3',
      method: 'setStatus',
      statusKey: 'ext',
    });
    expect(cleared).toEqual([]);
  });
});
