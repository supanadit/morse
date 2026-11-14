import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../host/morse.service';
import { PromptTemplatesState } from './prompt-templates-state';

/** The editor's host double: one engine, one viewing session, no real files. */
function setup() {
  const requestHostCommand = vi.fn(
    async (command: unknown): Promise<unknown> =>
      command === 'configFix'
        ? { ok: true, path: '/repo/.pi/prompts/plan.md', scope: 'project', issues: [] }
        : {
            templates: [],
            globalDir: '/home/user/.pi/agent/prompts',
            projectDir: '/repo/.pi/prompts',
            trusted: true,
            issues: [],
          },
  );
  const fake = {
    capabilities: signal({ promptEditor: true, scope: 'workspace' }),
    engine: signal<string | undefined>('pi'),
    state: signal({ sessionId: undefined }),
    workspace: signal({ cwd: '/repo', name: 'repo' }),
    requestHostCommand,
    refreshCommands: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
  return { requestHostCommand, state: TestBed.inject(PromptTemplatesState) };
}

afterEach(() => TestBed.resetTestingModule());

describe('PromptTemplatesState issues and Fix', () => {
  it('parses the config issues the host attached to the list', async () => {
    const { requestHostCommand, state } = setup();
    requestHostCommand.mockResolvedValue({
      templates: [],
      globalDir: '/home/user/.pi/agent/prompts',
      projectDir: '/repo/.pi/prompts',
      trusted: true,
      issues: [
        {
          file: '/repo/.pi/prompts/plan.md',
          fileId: 'config',
          scope: 'project',
          code: 'frontmatter',
          message: 'the frontmatter is not valid YAML',
          fixable: false,
        },
      ],
    });

    const result = await state.refresh(true);
    expect(result?.issues).toEqual([
      {
        file: '/repo/.pi/prompts/plan.md',
        fileId: 'config',
        scope: 'project',
        code: 'frontmatter',
        message: 'the frontmatter is not valid YAML',
        fixable: false,
      },
    ]);
  });

  it('fixes an issue through the host, then re-reads the templates', async () => {
    const { requestHostCommand, state } = setup();
    await state.refresh(true);

    const result = await state.fix({
      file: '/repo/.pi/prompts/plan.md',
      fileId: 'config',
      scope: 'project',
      code: 'normalize',
      message: 'rewrite this file',
      fixable: true,
    });

    expect(result.ok).toBe(true);
    expect(requestHostCommand).toHaveBeenCalledWith(
      'configFix',
      {
        fileId: 'config',
        path: '/repo/.pi/prompts/plan.md',
        scope: 'project',
        cwd: '/repo',
        engine: 'pi',
      },
      expect.any(Number),
    );
    const reads = requestHostCommand.mock.calls.filter(
      ([command]) => command === 'promptTemplates',
    );
    // The initial read plus the one Fix forces.
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a host without the Fix command instead of claiming success', async () => {
    const { requestHostCommand, state } = setup();
    requestHostCommand.mockResolvedValue(undefined);

    const result = await state.fix({
      file: '/repo/.pi/prompts/plan.md',
      fileId: 'config',
      scope: 'project',
      code: 'normalize',
      message: 'rewrite this file',
      fixable: true,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });
});
