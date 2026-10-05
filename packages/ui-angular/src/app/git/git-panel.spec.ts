import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../core/morse.service';
import { ShellState } from '../core/shell-state';
import { asGitLog, asGitSync, GitPanelState } from '../core/git-panel-state';
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

function setup(
  result: unknown,
  options: {
    status?: unknown;
    files?: string[];
    /** Read the mock working tree each time (a staging test mutates it). */
    getStatus?: () => unknown;
    /** Answer `gitStage`/`gitUnstage`; return the fresh working tree. */
    onGitMutation?: (command: string, paths: string[]) => unknown;
    /** Answer `gitCommitFiles` with one commit's changed paths. */
    commitFiles?: unknown;
    /** Answer `gitSync`/`gitPull`/`gitPush` with the branch distance. */
    sync?: unknown;
    /** Answer `gitBranches` with the branches the picker lists. */
    branches?: unknown;
    /** Answer `gitCommit`/`gitCheckout` with a mutation verdict. */
    mutation?: unknown;
  } = {},
) {
  const fake = {
    workspace: signal({ cwd: '/mock/workspace', name: 'morse' }),
    capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
    state: signal({
      sessionId: undefined,
      workspace: { cwd: '/mock/workspace', name: 'morse' },
    }),
    requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'listFiles') {
        return Promise.resolve({ files: options.files ?? [] });
      }
      if (command === 'gitStatus') {
        return Promise.resolve(options.getStatus ? options.getStatus() : options.status);
      }
      if (command === 'gitStage' || command === 'gitUnstage') {
        const paths = Array.isArray(args?.['paths'])
          ? (args!['paths'] as string[]).filter((path) => typeof path === 'string')
          : [];
        return Promise.resolve(
          options.onGitMutation ? options.onGitMutation(command, paths) : options.status,
        );
      }
      if (command === 'gitCommitFiles') {
        return Promise.resolve(options.commitFiles ?? { isRepo: true, hash: '', files: [] });
      }
      if (command === 'gitCommitDiff') {
        return Promise.resolve({ path: String(args?.['path'] ?? ''), diff: '' });
      }
      if (command === 'gitSync' || command === 'gitPull' || command === 'gitPush') {
        return Promise.resolve(options.sync ?? { isRepo: true, branch: 'main', ahead: 0, behind: 0 });
      }
      if (command === 'gitBranches') {
        return Promise.resolve(
          options.branches ?? {
            isRepo: true,
            current: 'main',
            local: ['main'],
            remote: [],
            tags: [],
          },
        );
      }
      if (command === 'gitCommit' || command === 'gitCheckout') {
        return Promise.resolve(options.mutation ?? { ok: true });
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

/** The `.change-group` whose sub-heading is `title` (“Staged” / “Unstaged”). */
function groupByTitle(host: HTMLElement, title: string): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('.change-group')].find(
    (group) => group.querySelector('.change-group-title')?.textContent?.trim() === title,
  );
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

  it('shows the full commit in the row hover tooltip', async () => {
    const long = 'feat(ui): round out the tab strip with a description the sidebar trims';
    const { fixture } = setup({
      ...LOG,
      commits: [
        {
          ...LOG.commits[0],
          subject: long,
          author: 'Ada Lovelace',
          refs: ['HEAD -> main', 'origin/main', 'tag: v0.9.5'],
        },
        LOG.commits[1],
      ],
    });
    await settle(fixture);

    const row = (fixture.nativeElement as HTMLElement).querySelector('.commit-row') as HTMLElement;
    const title = row.getAttribute('title') ?? '';
    // The full subject, and every ref — the two trimmed away in the sidebar.
    expect(title).toContain(long);
    expect(title).toContain('HEAD → main');
    expect(title).toContain('origin/main');
    expect(title).toContain('tag v0.9.5');
    // The identity git would print alongside them.
    expect(title).toContain('Ada Lovelace');
    expect(title).toContain('f1a2b3c4');
  });

  it('unfolds a commit to its changed files and opens one as a commit diff', async () => {
    const commitFiles = {
      isRepo: true,
      hash: LOG.commits[0].hash,
      files: [
        { path: 'src/a.ts', status: 'M ' },
        { path: 'src/b.ts', status: 'A ' },
      ],
    };
    const { fixture, fake } = setup(LOG, { files: [], commitFiles });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLElement>('.commit-row')!.click();
    await settle(fixture);

    expect(fake.requestHostCommand).toHaveBeenCalledWith('gitCommitFiles', {
      hash: LOG.commits[0].hash,
    });
    const names = [...host.querySelectorAll('.commit-file .change-name')].map((node) =>
      node.textContent?.trim(),
    );
    expect(names).toEqual(['a.ts', 'b.ts']);
    // The lane that survives the commit is drawn across the expanded list, so
    // the graph line is not cut by the files.
    expect(host.querySelectorAll('.commit-files .commit-rail .rail').length).toBeGreaterThan(0);

    // Clicking a file opens a tab whose diff is against that commit, not HEAD.
    host.querySelector<HTMLButtonElement>('.commit-file')!.click();
    fixture.detectChanges();
    const tabs = TestBed.inject(WorkspaceTabs);
    expect(tabs.tabs().map((tab) => tab.id)).toContain(`commit:${LOG.commits[0].hash}:src/a.ts`);

    // Clicking the row again folds the list away.
    host.querySelector<HTMLElement>('.commit-row')!.click();
    fixture.detectChanges();
    expect(host.querySelector('.commit-files')).toBeNull();
  });

  it('shows the branch distance and pulls/pushes from the sync bar', async () => {
    const { fixture, fake } = setup(LOG, {
      files: [],
      sync: { isRepo: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2 },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const compact = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/g, '');
    const arrows = [...host.querySelectorAll('.sync-arrow')].map(compact);
    expect(arrows).toEqual(['↓2', '↑1']);
    expect(compact(host.querySelector('.sync-arrow.on'))).toBe('↓2');
    expect(host.querySelector('.sync-upstream')?.textContent).toContain('origin/main');

    host.querySelector<HTMLButtonElement>('button[aria-label="Pull"]')?.click();
    await settle(fixture);
    expect(fake.requestHostCommand).toHaveBeenCalledWith('gitPull', undefined, 180_000);

    host.querySelector<HTMLButtonElement>('button[aria-label="Push"]')?.click();
    await settle(fixture);
    expect(fake.requestHostCommand).toHaveBeenCalledWith('gitPush', undefined, 180_000);
  });

  it('commits what is staged from the message box', async () => {
    const { fixture, fake } = setup(LOG, {
      files: [],
      status: { isRepo: true, files: [{ path: 'a.ts', status: 'M ' }] },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const input = host.querySelector<HTMLInputElement>('.commit-input')!;
    const button = host.querySelector<HTMLButtonElement>('.commit-button')!;
    // Nothing typed and nothing staged is not a commit.
    expect(button.disabled).toBe(true);

    input.value = 'feat: a thing';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button.disabled).toBe(false);

    button.click();
    await settle(fixture);

    expect(fake.requestHostCommand).toHaveBeenCalledWith(
      'gitCommit',
      { message: 'feat: a thing' },
      60_000,
    );
    expect(input.value).toBe('');
  });

  it('shows why git refused the commit', async () => {
    const { fixture } = setup(LOG, {
      files: [],
      status: { isRepo: true, files: [{ path: 'a.ts', status: 'M ' }] },
      mutation: { ok: false, message: 'Nothing is staged to commit. Stage a change first.' },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const input = host.querySelector<HTMLInputElement>('.commit-input')!;
    input.value = 'feat: a thing';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('.commit-button')!.click();
    await settle(fixture);

    expect(host.querySelector('.commit-error')?.textContent).toContain('Nothing is staged');
  });

  it('refuses an empty index itself instead of asking git', async () => {
    const { fixture, fake } = setup(LOG, {
      files: [],
      status: { isRepo: true, files: [] },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const input = host.querySelector<HTMLInputElement>('.commit-input')!;
    input.value = 'asS';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    // Enter goes through `submitCommit`, which the disabled button does not stop.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(fixture);

    expect(host.querySelector('.commit-error')?.textContent).toContain('Nothing is staged');
    expect(fake.requestHostCommand.mock.calls.some(([command]) => command === 'gitCommit')).toBe(
      false,
    );
  });

  it('switches branch from the picker', async () => {
    const { fixture, fake } = setup(LOG, {
      files: [],
      branches: {
        isRepo: true,
        current: 'main',
        local: ['main', 'dev'],
        remote: ['origin/main', 'origin/topic'],
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>('.branch')!.click();
    await settle(fixture);

    expect(fake.requestHostCommand).toHaveBeenCalledWith('gitBranches');
    const rows = [...host.querySelectorAll<HTMLButtonElement>('morse-branch-picker .row')];
    expect(rows.some((row) => row.textContent?.includes('Create new branch'))).toBe(true);
    const dev = rows.find((row) => row.textContent?.trim() === 'dev')!;
    expect(dev).toBeDefined();

    dev.click();
    await settle(fixture);
    expect(fake.requestHostCommand).toHaveBeenCalledWith(
      'gitCheckout',
      { branch: 'dev', create: false },
      60_000,
    );
  });

  it('creates a new branch from the picker', async () => {
    const { fixture, fake } = setup(LOG, { files: [] });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>('.branch')!.click();
    await settle(fixture);
    host.querySelector<HTMLButtonElement>('morse-branch-picker .create-row')!.click();
    fixture.detectChanges();

    const name = host.querySelector<HTMLInputElement>('morse-branch-picker .name-input')!;
    name.value = 'feat/new';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('morse-branch-picker .primary')!.click();
    await settle(fixture);

    expect(fake.requestHostCommand).toHaveBeenCalledWith(
      'gitCheckout',
      { branch: 'feat/new', create: true },
      60_000,
    );
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

  it('splits the working tree into staged and unstaged groups', async () => {
    const status = {
      isRepo: true,
      files: [
        { path: 'staged.ts', status: 'M ' },
        { path: 'unstaged.ts', status: ' M' },
        { path: 'untracked.ts', status: '??' },
        { path: 'both.ts', status: 'MM' },
      ],
    };
    const { fixture } = setup(LOG, { files: [], getStatus: () => status });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const groups = [...host.querySelectorAll('.change-group')];
    const names = (group: Element) =>
      [...group.querySelectorAll('.change-name')].map((node) => node.textContent?.trim());
    expect(groups).toHaveLength(2);
    expect(names(groupByTitle(host, 'Staged')!)).toEqual(['both.ts', 'staged.ts']);
    expect(names(groupByTitle(host, 'Unstaged')!)).toEqual(['both.ts', 'unstaged.ts', 'untracked.ts']);
    expect(host.querySelector('.change-group-title')?.textContent?.trim()).toBe('Staged');
  });

  it('keeps the Staged group with an empty note when nothing is staged', async () => {
    const { fixture } = setup(LOG, {
      files: [],
      status: { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    // The group never disappears: the commit flow needs a stable home, and an
    // empty one says what to do instead of leaving a gap.
    const staged = groupByTitle(host, 'Staged');
    expect(staged).toBeDefined();
    expect(staged?.querySelector('.change-empty')?.textContent).toContain('No staged files');
    expect(staged?.querySelectorAll('.change-row')).toHaveLength(0);
  });

  it('folds a change group from its header, independently', async () => {
    const { fixture } = setup(LOG, {
      files: [],
      status: {
        isRepo: true,
        files: [
          { path: 'staged.ts', status: 'M ' },
          { path: 'unstaged.ts', status: ' M' },
        ],
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const toggle = (title: string) =>
      groupByTitle(host, title)!.querySelector<HTMLButtonElement>('.group-toggle')!;

    toggle('Staged').click();
    fixture.detectChanges();
    // The rows fold under the header, which stays put; the other group is untouched.
    expect(groupByTitle(host, 'Staged')?.querySelectorAll('.change-row')).toHaveLength(0);
    expect(toggle('Staged').getAttribute('aria-expanded')).toBe('false');
    expect(groupByTitle(host, 'Unstaged')?.querySelectorAll('.change-row')).toHaveLength(1);

    toggle('Staged').click();
    fixture.detectChanges();
    expect(groupByTitle(host, 'Staged')?.querySelectorAll('.change-row')).toHaveLength(1);
  });

  it('stages an unstaged path from its row', async () => {
    let status: unknown = { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] };
    const calls: Array<{ command: string; paths: string[] }> = [];
    const { fixture } = setup(LOG, {
      files: [],
      getStatus: () => status,
      onGitMutation: (command, paths) => {
        calls.push({ command, paths });
        status = { isRepo: true, files: [{ path: 'a.ts', status: 'M ' }] };
        return status;
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const unstaged = groupByTitle(host, 'Unstaged')!;
    unstaged.querySelector<HTMLButtonElement>('.change-action')?.click();
    await settle(fixture);

    expect(calls).toEqual([{ command: 'gitStage', paths: ['a.ts'] }]);
    const staged = groupByTitle(host, 'Staged')!;
    expect([...staged.querySelectorAll('.change-name')].map((node) => node.textContent?.trim())).toEqual([
      'a.ts',
    ]);
  });

  it('unstages a staged path from its row', async () => {
    let status: unknown = { isRepo: true, files: [{ path: 'a.ts', status: 'M ' }] };
    const calls: Array<{ command: string; paths: string[] }> = [];
    const { fixture } = setup(LOG, {
      files: [],
      getStatus: () => status,
      onGitMutation: (command, paths) => {
        calls.push({ command, paths });
        status = { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] };
        return status;
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const staged = groupByTitle(host, 'Staged')!;
    staged.querySelector<HTMLButtonElement>('.change-action')?.click();
    await settle(fixture);

    expect(calls).toEqual([{ command: 'gitUnstage', paths: ['a.ts'] }]);
    const unstaged = groupByTitle(host, 'Unstaged')!;
    expect([...unstaged.querySelectorAll('.change-name')].map((node) => node.textContent?.trim())).toEqual([
      'a.ts',
    ]);
  });

  it('stages every unstaged path from the group header', async () => {
    let status: unknown = {
      isRepo: true,
      files: [
        { path: 'a.ts', status: ' M' },
        { path: 'b.ts', status: '??' },
        { path: 'c.ts', status: 'M ' },
      ],
    };
    const calls: Array<{ command: string; paths: string[] }> = [];
    const { fixture } = setup(LOG, {
      files: [],
      getStatus: () => status,
      onGitMutation: (command, paths) => {
        calls.push({ command, paths });
        status = {
          isRepo: true,
          files: [
            { path: 'a.ts', status: 'M ' },
            { path: 'b.ts', status: 'A ' },
            { path: 'c.ts', status: 'M ' },
          ],
        };
        return status;
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const unstaged = groupByTitle(host, 'Unstaged')!;
    unstaged.querySelector<HTMLButtonElement>('.group-action')?.click();
    await settle(fixture);

    expect(calls).toEqual([{ command: 'gitStage', paths: ['a.ts', 'b.ts'] }]);
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
      capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
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

describe('asGitSync', () => {
  it('keeps the distance and drops junk counts', () => {
    const sync = asGitSync({
      isRepo: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 3,
      behind: -1,
    });
    expect(sync).toEqual({
      isRepo: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 3,
      behind: 0,
    });
  });

  it('rejects a reply that is not a sync', () => {
    expect(asGitSync(undefined)).toBeUndefined();
    expect(asGitSync({ ahead: 1 })).toBeUndefined();
  });
});
