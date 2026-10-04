import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../core/morse.service';
import { ShellState } from '../core/shell-state';
import { asGitLog, GitPanelState } from '../core/git-panel-state';
import { WorkspaceTabs } from '../core/workspace-tabs';
import { GitPanel } from './git-panel';

const LOG = {
  isRepo: true,
  root: '/mock/workspace',
  branch: 'main',
  commits: [
    {
      hash: 'f1a2b3c4',
      shortHash: 'f1a2b3c',
      parents: ['e2f3a4b5'],
      refs: ['HEAD -> main'],
      author: 'A',
      date: new Date().toISOString(),
      subject: 'Add the git panel',
    },
    {
      hash: 'e2f3a4b5',
      shortHash: 'e2f3a4b',
      parents: [],
      refs: ['tag: v0.8.0'],
      author: 'A',
      date: new Date().toISOString(),
      subject: 'Initial commit',
    },
  ],
};

function setup(result: unknown, options: { status?: unknown; files?: string[] } = {}) {
  const fake = {
    workspace: signal({ cwd: '/mock/workspace', name: 'morse' }),
    capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
    requestHostCommand: vi.fn((command: string) => {
      if (command === 'listFiles') {
        return Promise.resolve({ files: options.files ?? [] });
      }
      if (command === 'gitStatus') {
        return Promise.resolve(options.status);
      }
      return Promise.resolve(result);
    }),
  };
  TestBed.configureTestingModule({
    imports: [GitPanel],
    providers: [{ provide: MorseService, useValue: fake }],
  });
  // The panel refreshes only while it is open; the layout flag lives in ShellState.
  TestBed.inject(ShellState).toggleGitPanel();
  const fixture = TestBed.createComponent(GitPanel);
  fixture.detectChanges();
  return { fixture, fake };
}

async function settle(fixture: ReturnType<typeof TestBed.createComponent<GitPanel>>) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

describe('GitPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('renders commits, refs and their graph', async () => {
    const { fixture, fake } = setup(LOG);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(fake.requestHostCommand).toHaveBeenCalledWith('gitLog', { max: 250, skip: 0 });
    expect(host.querySelectorAll('.commit')).toHaveLength(2);
    expect(host.textContent).toContain('Add the git panel');
    // The node plus the edge between the two commits.
    expect(host.querySelectorAll('.graph circle').length).toBe(2);
    expect(host.querySelectorAll('.graph path').length).toBeGreaterThan(0);
    expect(host.querySelector('.branch')?.textContent).toContain('main');
    expect(host.querySelector('.ref.kind-tag')?.textContent).toContain('v0.8.0');
    expect(host.querySelector('.ref.kind-head')?.textContent).toContain('main');
  });

  it('caps a long ref but keeps its full name in the title', async () => {
    const long = 'origin/feat/pms-production-rebalance-sales-purchase-per-node';
    const { fixture } = setup({
      ...LOG,
      commits: [{ ...LOG.commits[0], refs: [long] }, LOG.commits[1]],
    });
    await settle(fixture);

    // The chip is CSS-capped; the full name survives for the hover tooltip.
    const ref = (fixture.nativeElement as HTMLElement).querySelector('.ref') as HTMLElement;
    expect(ref.getAttribute('title')).toBe(long);
  });

  it('folds a commit\'s extra branches into +N in the sidebar', async () => {
    const { fixture } = setup({
      ...LOG,
      commits: [
        { ...LOG.commits[0], refs: ['HEAD -> main', 'origin/main', 'origin/HEAD'] },
        LOG.commits[1],
      ],
    });
    await settle(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const refs = host.querySelector('.commit')!.querySelectorAll('.ref');
    expect(refs).toHaveLength(2);
    expect(refs[1].textContent?.trim()).toBe('+2');
    // The folded names are one hover away on the counter.
    expect(refs[1].getAttribute('title')).toContain('origin/main');
  });

  it('says when the project is not a repository', async () => {
    const { fixture } = setup({ isRepo: false, commits: [] });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'not a git repository',
    );
  });

  it('shows an animated, centred mark when there are no changes', async () => {
    const { fixture } = setup(LOG, { files: [], status: { isRepo: true, files: [] } });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.changes .empty .mark')).not.toBeNull();
    expect(host.querySelector('.changes .empty .mark .check')).not.toBeNull();
    expect(host.textContent).toContain('No uncommitted changes');
  });

  it('lists uncommitted changes above the graph and opens one in a tab', async () => {
    const { fixture } = setup(LOG, {
      files: ['a.ts', 'b.ts'],
      status: {
        isRepo: true,
        files: [
          { path: 'a.ts', status: ' M' },
          { path: 'b.ts', status: '??' },
        ],
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const names = [...host.querySelectorAll('.change .change-name')].map((node) =>
      node.textContent?.trim(),
    );
    const badges = [...host.querySelectorAll('.change .badge')].map((node) =>
      node.textContent?.trim(),
    );
    expect(names).toEqual(['a.ts', 'b.ts']);
    expect(badges).toEqual(['M', 'U']);

    host.querySelector<HTMLButtonElement>('.change')?.click();
    expect(TestBed.inject(WorkspaceTabs).tabs().map((tab) => tab.id)).toEqual(['file:a.ts']);
  });

  it('folds the changes section away from its header', async () => {
    const { fixture } = setup(LOG, {
      files: ['a.ts'],
      status: { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.change-list')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('.section-toggle')?.click();
    fixture.detectChanges();

    expect(host.querySelector('.change-list')).toBeNull();
    expect(host.querySelector('.body.changes-collapsed')).not.toBeNull();
  });

  it('offers a left-edge handle to resize the panel against the conversation', async () => {
    const { fixture } = setup(LOG);
    await settle(fixture);
    const handle = (fixture.nativeElement as HTMLElement).querySelector('.edge-resize');
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute('aria-label')).toBe('Resize the git panel');
  });

  it('takes the full width and shows the author when expanded', async () => {
    const { fixture } = setup(LOG);
    await settle(fixture);
    fixture.componentRef.setInput('expanded', true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.panel.full')).toBeTruthy();
    expect(host.querySelector('.commit.expanded .author')?.textContent).toContain('A');

    // The header's expand button flips the shell's layout flag.
    const shell = TestBed.inject(ShellState);
    const before = shell.gitPanelExpanded();
    host.querySelector<HTMLButtonElement>('.icon[aria-label="Collapse the git panel"]')?.click();
    expect(shell.gitPanelExpanded()).toBe(!before);
  });
});

describe('asGitLog', () => {
  it('keeps the commits it understands and drops the rest', () => {
    const parsed = asGitLog({
      isRepo: true,
      root: '/r',
      branch: 'main',
      commits: [LOG.commits[0], { hash: 1 }, null],
    });
    expect(parsed?.commits).toHaveLength(1);
    expect(parsed?.commits[0]?.subject).toBe('Add the git panel');
    expect(parsed?.branch).toBe('main');
  });

  it('rejects a reply that is not a git log', () => {
    expect(asGitLog(undefined)).toBeUndefined();
    expect(asGitLog({ commits: [] })).toBeUndefined();
  });
});

describe('GitPanelState paging', () => {
  afterEach(() => TestBed.resetTestingModule());

  function page(from: number, count: number) {
    return Array.from({ length: count }, (_, index) => {
      const n = from + index;
      return {
        hash: `h${n}`,
        shortHash: `h${n}`.slice(0, 7),
        parents: [],
        refs: [],
        author: 'A',
        date: '2024-01-01T00:00:00Z',
        subject: `c${n}`,
      };
    });
  }

  it('appends the next page until the root, then stops', async () => {
    const fake = {
      workspace: signal({ cwd: '/r', name: 'r' }),
      requestHostCommand: vi.fn((_command: string, args?: Record<string, unknown>) => {
        const skip = Number(args?.['skip'] ?? 0);
        const commits = skip === 0 ? page(0, 250) : page(250, 3);
        return Promise.resolve({ isRepo: true, root: '/r', branch: 'main', commits });
      }),
    };
    TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
    const state = TestBed.inject(GitPanelState);

    state.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.commits()).toHaveLength(250);
    expect(state.hasMore()).toBe(true);

    state.loadMore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.commits()).toHaveLength(253);
    expect(state.hasMore()).toBe(false);
    expect(fake.requestHostCommand).toHaveBeenLastCalledWith('gitLog', { max: 250, skip: 250 });
  });
});
