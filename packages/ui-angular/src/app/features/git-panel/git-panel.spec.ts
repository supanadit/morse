import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { LayoutState } from '../../state/layout-state';
import { asGitLog, asGitSync, GitPanelState } from '../../services/git-panel-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
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
    onGitMutation?: (command: string, paths: string[], repo?: string) => unknown;
    /** Answer `gitCommitFiles` with one commit's changed paths. */
    commitFiles?: unknown;
    /** Answer `gitSync`/`gitPull`/`gitPush` with the branch distance. */
    sync?: unknown;
    /** Answer `gitBranches` with the branches the picker lists. */
    branches?: unknown;
    /** Answer `gitCommit`/`gitCheckout` with a mutation verdict. */
    mutation?: unknown;
    /** The repositories `gitRepos` lists; defaults to the session's own. */
    repos?: unknown;
  } = {},
) {
  const repoList =
    options.repos ?? {
      isRepo: true,
      repos: [
        {
          path: '',
          root: '/mock/workspace',
          name: 'morse',
          current: true,
          branch: 'main',
        },
      ],
    };
  const fake = {
    workspace: signal({ cwd: '/mock/workspace', name: 'morse' }),
    capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
    state: signal({
      sessionId: undefined,
      workspace: { cwd: '/mock/workspace', name: 'morse' },
    }),
    requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'gitRepos') {
        return Promise.resolve(repoList);
      }
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
        const repo = typeof args?.['repo'] === 'string' ? (args!['repo'] as string) : undefined;
        return Promise.resolve(
          options.onGitMutation
            ? options.onGitMutation(command, paths, repo)
            : (options.getStatus ? options.getStatus() : options.status),
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
      // `gitLog` and anything else named: the history result.
      return Promise.resolve(result);
    }),
  };
  TestBed.configureTestingModule({
    imports: [GitPanel],
    providers: [{ provide: MorseService, useValue: fake }],
  });
  // The panel refreshes only while it is open; the layout flag lives in ShellState.
  TestBed.inject(LayoutState).setVisible('right', true);
  const fixture = TestBed.createComponent(GitPanel);
  fixture.detectChanges();
  return { fixture, fake };
}

async function settle(fixture: ReturnType<typeof TestBed.createComponent<GitPanel>>) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

/** The `morse-tree` group row whose label is `label` (“Staged” / “Unstaged”). */
function groupByTitle(host: HTMLElement, label: string): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('.changes-tree .row.group')].find(
    (row) => row.querySelector('.label')?.textContent?.trim() === label,
  );
}

/** The file labels inside a change group, in the order they are drawn. */
function groupFileNames(host: HTMLElement, group: string): string[] {
  // The tree draws one flat row list: a group's files are the leaf rows between
  // its own group row and the next group row.
  const lines = [...host.querySelectorAll<HTMLElement>('.changes-tree .line')];
  const start = lines.findIndex(
    (line) =>
      line.querySelector('.row.group .label')?.textContent?.trim() === group,
  );
  if (start === -1) {
    return [];
  }
  const names: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const row = lines[index].querySelector('.row');
    if (row?.classList.contains('group')) {
      break;
    }
    names.push(row?.querySelector('.label')?.textContent?.trim() ?? '');
  }
  return names;
}

describe('GitPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('leaves history to the bottom panel', async () => {
    const { fixture } = setup(LOG);
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.history')).toBeNull();
    expect(host.querySelector('.commit')).toBeNull();
    expect(host.querySelector('.divider')).toBeNull();
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
      { message: 'feat: a thing', amend: false },
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

  it('re-reads the repository identity when the project switches', async () => {
    // Both projects' own repository is the relative path `''`; keying the panel's
    // repo state by that path alone left the previous project's name/branch in
    // place after a switch, while only the history refreshed.
    const workspace = signal({ cwd: '/one', name: 'one' });
    const fake = {
      workspace,
      capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
      state: signal({ sessionId: 's1', workspace: { cwd: '/one', name: 'one' } }),
      requestHostCommand: vi.fn((command: string) => {
        const cwd = workspace().cwd;
        if (command === 'gitRepos') {
          return Promise.resolve({
            isRepo: true,
            repos: [
              {
                path: '',
                root: cwd,
                name: workspace().name,
                current: true,
                branch: cwd === '/one' ? 'one-branch' : 'two-branch',
              },
            ],
          });
        }
        if (command === 'gitSync') {
          return Promise.resolve({ isRepo: true, branch: 'main', ahead: 0, behind: 0 });
        }
        if (command === 'gitStatus') {
          return Promise.resolve({ isRepo: true, files: [] });
        }
        return Promise.resolve({
          isRepo: true,
          root: cwd,
          branch: cwd === '/one' ? 'one-branch' : 'two-branch',
          commits: [
            {
              hash: cwd === '/one' ? 'a1111111' : 'b2222222',
              shortHash: cwd === '/one' ? 'a111111' : 'b222222',
              parents: [],
              refs: ['HEAD -> main'],
              author: 'A',
              date: new Date().toISOString(),
              subject: cwd === '/one' ? 'commit in one' : 'commit in two',
            },
          ],
        });
      }),
    };
    TestBed.configureTestingModule({
      imports: [GitPanel],
      providers: [{ provide: MorseService, useValue: fake }],
    });
    TestBed.inject(LayoutState).setVisible('right', true);
    const fixture = TestBed.createComponent(GitPanel);
    fixture.detectChanges();
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.repo-name')?.textContent?.trim()).toBe('one');
    expect(host.querySelector('.branch-name')?.textContent?.trim()).toBe('one-branch');

    workspace.set({ cwd: '/two', name: 'two' });
    fixture.detectChanges();
    await settle(fixture);

    // The new project's repository, not the previous one's stale identity.
    expect(host.querySelector('.repo-name')?.textContent?.trim()).toBe('two');
    expect(host.querySelector('.branch-name')?.textContent?.trim()).toBe('two-branch');
  });

  it('says when the project is not a repository', async () => {
    const { fixture } = setup({ isRepo: false, commits: [] }, {
      repos: { isRepo: false, repos: [] },
    });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'not a git repository',
    );
  });

  it('shows an animated, centred mark when there are no changes', async () => {
    const { fixture } = setup(LOG, { files: [], status: { isRepo: true, files: [] } });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.repo-detail-pane .empty .mark')).not.toBeNull();
    expect(host.querySelector('.repo-detail-pane .empty .mark .check')).not.toBeNull();
    expect(host.textContent).toContain('No uncommitted changes');
  });

  it('draws the whole changes area, form and groups, in one open repository', async () => {
    const { fixture } = setup(LOG, {
      files: [],
      status: { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    // The sync row, the commit form and both change groups live in the open
    // repository's detail pane, so they scroll together.
    const detail = host.querySelector('.repo-detail-pane') as HTMLElement;
    expect(detail).not.toBeNull();
    expect(detail.querySelector('.sync')).not.toBeNull();
    expect(detail.querySelector('.commit-box')).not.toBeNull();
    expect(detail.querySelector('.changes-tree')).not.toBeNull();
    expect(detail.querySelector('.changes-scroll')).not.toBeNull();

    // Folding the repository takes the form and the tree with it.
    host.querySelector<HTMLButtonElement>('.repo-toggle')?.click();
    fixture.detectChanges();
    expect(host.querySelector('.commit-box')).toBeNull();
    expect(host.querySelector('.changes-tree')).toBeNull();
    expect(host.querySelector('.repo-detail-pane')).toBeNull();
  });

  it('opens one repository in place and leaves the other headers put', async () => {
    const { fixture } = setup(LOG, {
      files: [],
      status: { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] },
      repos: {
        isRepo: true,
        repos: [
          { path: '', root: '/mock/workspace', name: 'morse', current: true, branch: 'main' },
          {
            path: 'packages/sub',
            root: '/mock/workspace/packages/sub',
            name: 'sub',
            current: false,
            branch: 'dev',
          },
        ],
      },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    /** The header labels in the order they are drawn. */
    const headerNames = (): string[] =>
      [...host.querySelectorAll<HTMLElement>('.repo-head .repo-name')].map(
        (node) => node.textContent?.trim() ?? '',
      );

    // The session's own repository is open by default; only one detail pane.
    expect(headerNames()).toEqual(['morse', 'sub']);
    expect(host.querySelectorAll('.repo-detail-pane')).toHaveLength(1);
    // A nested repo whose path differs from its folder name shows the path too.
    expect(host.querySelectorAll<HTMLElement>('.repo-head')[1]!.querySelector('.repo-detail')?.textContent?.trim()).toBe(
      'packages/sub',
    );

    // Opening the second expands it *in place*: the header order never changes,
    // there is still one detail pane, and it sits directly under its own header.
    host.querySelectorAll<HTMLButtonElement>('.repo-toggle')[1]!.click();
    fixture.detectChanges();
    expect(headerNames()).toEqual(['morse', 'sub']);
    expect(host.querySelectorAll('.repo-detail-pane')).toHaveLength(1);
    const secondHead = host.querySelectorAll<HTMLElement>('.repo-head')[1]!;
    expect(secondHead.classList.contains('open')).toBe(true);
    const detail = host.querySelector('.repo-detail-pane') as HTMLElement;
    expect(
      secondHead.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Clicking the open header again folds it, leaving only the headers.
    secondHead.querySelector<HTMLButtonElement>('.repo-toggle')!.click();
    fixture.detectChanges();
    expect(host.querySelector('.repo-detail-pane')).toBeNull();
    expect(host.querySelectorAll('.repo-head')).toHaveLength(2);
  });

  it('lists uncommitted changes and opens one in a tab', async () => {
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

    const rows = [...host.querySelectorAll('.changes-tree .row:not(.group)')];
    const names = rows.map((node) => node.querySelector('.label')?.textContent?.trim());
    const badges = rows.map((node) => node.querySelector('.badge')?.textContent?.trim());
    expect(names).toEqual(['a.ts', 'b.ts']);
    expect(badges).toEqual(['M', 'U']);
    // Each changed file wears the mark the Explorer gives it, and the group the branch.
    const marks = rows.map((node) => node.querySelector('use')?.getAttribute('href'));
    expect(marks).toEqual(['#morse-code', '#morse-code']);
    const group = groupByTitle(host, 'Unstaged');
    expect(group?.querySelector('use')?.getAttribute('href')).toBe('#morse-git');

    (rows[0] as HTMLButtonElement).click();
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

    const groups = [...host.querySelectorAll('.changes-tree .row.group')];
    expect(groups).toHaveLength(2);
    expect(groupFileNames(host, 'Staged')).toEqual(['both.ts', 'staged.ts']);
    expect(groupFileNames(host, 'Unstaged')).toEqual([
      'both.ts',
      'unstaged.ts',
      'untracked.ts',
    ]);
    // The group's own badge is its count, and its action stages the whole group.
    expect(groupByTitle(host, 'Staged')?.querySelector('.badge')?.textContent?.trim()).toBe('2');
    expect(
      groupByTitle(host, 'Unstaged')?.closest('.line')?.querySelector('.row-action'),
    ).not.toBeNull();
  });

  it('keeps the Staged group when nothing is staged', async () => {
    const { fixture } = setup(LOG, {
      files: [],
      status: { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    // The group never disappears: the commit flow needs a stable home, so an
    // empty Staged group is drawn with a zero count and no file rows.
    const staged = groupByTitle(host, 'Staged');
    expect(staged).toBeDefined();
    expect(staged?.querySelector('.badge')?.textContent?.trim()).toBe('0');
    expect(groupFileNames(host, 'Staged')).toHaveLength(0);
  });

  it('folds a change group from its caret, independently', async () => {
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
    const caret = (label: string) =>
      groupByTitle(host, label)!.closest('.line')!.querySelector<HTMLButtonElement>('.chevron')!;

    caret('Staged').click();
    fixture.detectChanges();
    // The rows fold under the group, which stays put; the other group is untouched.
    expect(groupFileNames(host, 'Staged')).toHaveLength(0);
    expect(caret('Staged').getAttribute('aria-expanded')).toBe('false');
    expect(groupFileNames(host, 'Unstaged')).toHaveLength(1);

    caret('Staged').click();
    fixture.detectChanges();
    expect(groupFileNames(host, 'Staged')).toHaveLength(1);
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
    unstaged.closest('.line')!.querySelector<HTMLButtonElement>('.row-action')?.click();
    await settle(fixture);

    expect(calls).toEqual([{ command: 'gitStage', paths: ['a.ts'] }]);
    expect(groupFileNames(host, 'Staged')).toEqual(['a.ts']);
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
    staged.closest('.line')!.querySelector<HTMLButtonElement>('.row-action')?.click();
    await settle(fixture);

    expect(calls).toEqual([{ command: 'gitUnstage', paths: ['a.ts'] }]);
    expect(groupFileNames(host, 'Unstaged')).toEqual(['a.ts']);
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
    unstaged.closest('.line')!.querySelector<HTMLButtonElement>('.row-action')?.click();
    await settle(fixture);

    expect(calls).toEqual([{ command: 'gitStage', paths: ['a.ts', 'b.ts'] }]);
  });

  it('folds a repository section away from its header', async () => {
    const { fixture } = setup(LOG, {
      files: ['a.ts'],
      status: { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] },
    });
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.changes-tree')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('.repo-toggle')?.click();
    fixture.detectChanges();

    expect(host.querySelector('.changes-tree')).toBeNull();
    expect(host.querySelector('.repo-detail-pane')).toBeNull();
  });

  it('offers a left-edge handle to resize the panel against the conversation', async () => {
    const { fixture } = setup(LOG);
    await settle(fixture);
    const handle = (fixture.nativeElement as HTMLElement).querySelector('.edge-resize');
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute('aria-label')).toBe('Resize the git panel');
  });

  it('takes the full width when expanded', async () => {
    const { fixture } = setup(LOG);
    await settle(fixture);
    fixture.componentRef.setInput('expanded', true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.panel.full')).toBeTruthy();

    // The header's expand button flips the shell's layout flag.
    const shell = TestBed.inject(ShellState);
    const before = shell.gitPanelExpanded();
    host
      .querySelector<HTMLButtonElement>(
        '.pane-action[aria-label="Fit the git panel back into the sidebar"]',
      )
      ?.click();
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

  /** A state whose host answers repos, status, ref-scoped log and a commit. */
  function refState() {
    const fake = {
      workspace: signal({ cwd: '/r', name: 'r' }),
      capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
      requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
        if (command === 'gitRepos') {
          return Promise.resolve({
            isRepo: true,
            repos: [{ path: '', root: '/r', name: 'r', current: true, branch: 'main' }],
          });
        }
        if (command === 'gitSync') {
          return Promise.resolve({ isRepo: true, branch: 'main', ahead: 0, behind: 0 });
        }
        if (command === 'gitStatus') {
          return Promise.resolve({ isRepo: true, files: [] });
        }
        if (command === 'gitCommit') {
          return Promise.resolve({ ok: true });
        }
        if (args?.['ref'] === 'feat') {
          return Promise.resolve({
            isRepo: true,
            root: '/r',
            branch: 'main',
            commits: [{ ...page(0, 1)[0]!, subject: 'feat c' }],
          });
        }
        return Promise.resolve({ isRepo: true, root: '/r', branch: 'main', commits: page(0, 1) });
      }),
    };
    TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
    return { fake, state: TestBed.inject(GitPanelState) };
  }

  it('reloads from the first page when a ref is selected', async () => {
    const { fake, state } = refState();
    state.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const repo = state.repos()[0]!;

    repo.setLogRef('feat');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.requestHostCommand).toHaveBeenLastCalledWith('gitLog', {
      max: 250,
      skip: 0,
      ref: 'feat',
    });
    expect(repo.commits().map((c) => c.subject)).toEqual(['feat c']);

    repo.setLogRef(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.requestHostCommand).toHaveBeenLastCalledWith('gitLog', { max: 250, skip: 0 });
  });

  it('forwards amend to the host', async () => {
    const { fake, state } = refState();
    state.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const repo = state.repos()[0]!;

    await repo.commit('rewrite', true);

    expect(fake.requestHostCommand).toHaveBeenCalledWith(
      'gitCommit',
      { message: 'rewrite', amend: true },
      60_000,
    );
  });

  it('appends the next page per repository until the root, then stops', async () => {
    const fake = {
      workspace: signal({ cwd: '/r', name: 'r' }),
      capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
      requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
        if (command === 'gitRepos') {
          return Promise.resolve({
            isRepo: true,
            repos: [
              { path: '', root: '/r', name: 'r', current: true, branch: 'main' },
            ],
          });
        }
        if (command === 'gitSync') {
          return Promise.resolve({ isRepo: true, branch: 'main', ahead: 0, behind: 0 });
        }
        if (command === 'gitStatus') {
          return Promise.resolve({ isRepo: true, files: [] });
        }
        const skip = Number(args?.['skip'] ?? 0);
        const commits = skip === 0 ? page(0, 250) : page(250, 3);
        return Promise.resolve({ isRepo: true, root: '/r', branch: 'main', commits });
      }),
    };
    TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
    const state = TestBed.inject(GitPanelState);

    state.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const repo = state.repos()[0]!;
    expect(repo.commits()).toHaveLength(250);
    expect(repo.hasMore()).toBe(true);

    repo.loadMore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repo.commits()).toHaveLength(253);
    expect(repo.hasMore()).toBe(false);
    expect(fake.requestHostCommand).toHaveBeenLastCalledWith('gitLog', {
      max: 250,
      skip: 250,
    });
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
