import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { LayoutState } from '../../state/layout-state';
import { GitLogView, projectLog } from './git-log';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function commit(hash: string, parents: string[]) {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    refs: [],
    author: 'A',
    date: '2024-01-01T00:00:00Z',
    subject: hash,
  };
}

function fakeHost() {
  const branches = {
    isRepo: true,
    current: 'main',
    local: ['main', 'feat'],
    remote: ['origin/main'],
    tags: ['v1'],
  };
  const workspace = signal({ cwd: '/r', name: 'r' });
  return {
    workspace,
    state: signal({
      sessionId: undefined,
      workspace: { cwd: '/r', name: 'r' },
    }),
    capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
    requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command === 'gitRepos') {
        const cwd = workspace().cwd;
        return Promise.resolve({
          isRepo: true,
          repos: [
            {
              path: '',
              root: cwd,
              name: cwd === '/r' ? 'r' : 'other',
              current: true,
              branch: 'main',
            },
            ...(cwd === '/r'
              ? [
                  {
                    path: 'nested',
                    root: '/r/nested',
                    name: 'nested',
                    current: false,
                    branch: 'feat',
                  },
                ]
              : []),
          ],
        });
      }
      if (command === 'gitSync') {
        return Promise.resolve({ isRepo: true, branch: 'main', ahead: 0, behind: 0 });
      }
      if (command === 'gitStatus') {
        return Promise.resolve({ isRepo: true, files: [] });
      }
      if (command === 'gitBranches') {
        return Promise.resolve(branches);
      }
      if (command === 'gitCommitFiles') {
        return Promise.resolve({
          isRepo: true,
          hash: String(args?.['hash'] ?? ''),
          files: [{ path: 'src/a.ts', status: 'M' }],
        });
      }
      const ref = String(args?.['ref'] ?? '');
      const nested = args?.['repo'] === 'nested';
      if (workspace().cwd === '/other') {
        return Promise.resolve({
          isRepo: true,
          root: '/other',
          branch: 'main',
          commits: [
            {
              hash: 'o1',
              shortHash: 'o1',
              parents: [],
              refs: ['HEAD -> main'],
              author: 'Ada',
              date: new Date().toISOString(),
              subject: 'other work',
            },
          ],
        });
      }
      const commits = nested
        ? [
            {
              hash: 'n1',
              shortHash: 'n1',
              parents: [],
              refs: ['feat'],
              author: 'Grace',
              date: new Date().toISOString(),
              subject: 'nested work',
            },
          ]
        : ref === 'feat'
          ? [
              {
                hash: 'f1',
                shortHash: 'f1',
                parents: [],
                refs: ['feat'],
                author: 'Ada',
                date: new Date().toISOString(),
                subject: 'feat work',
              },
            ]
          : [
              {
                hash: 'm1',
                shortHash: 'm1',
                parents: [],
                refs: ['HEAD -> main'],
                author: 'Ada',
                date: new Date().toISOString(),
                subject: 'main work',
              },
              {
                hash: 'm0',
                shortHash: 'm0',
                parents: ['m1'],
                refs: [],
                author: 'Grace',
                date: new Date().toISOString(),
                subject: 'docs work',
              },
            ];
      return Promise.resolve({ isRepo: true, root: '/r', branch: 'main', commits });
    }),
  };
}

async function render(
  options: { failLog?: boolean; empty?: boolean } = {},
): Promise<{ fixture: ComponentFixture<GitLogView>; fake: ReturnType<typeof fakeHost> }> {
  const host = fakeHost();
  if (options.failLog) {
    host.requestHostCommand.mockImplementation(() => Promise.resolve(undefined));
  }
  if (options.empty) {
    const original = host.requestHostCommand.getMockImplementation()!;
    host.requestHostCommand.mockImplementation((command, args) =>
      command === 'gitLog'
        ? Promise.resolve({ isRepo: true, root: '/r', branch: 'main', commits: [] })
        : original(command, args),
    );
  }
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [GitLogView],
    providers: [{ provide: MorseService, useValue: host }],
  });
  const fixture = TestBed.createComponent(GitLogView);
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return { fixture, fake: host };
}

describe('GitLogView', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists the current branch and filters by a selected ref', async () => {
    const { fixture } = await render();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.commit .subject')?.textContent).toContain('main work');
    // The tree offers every ref kind the host returned.
    expect(host.querySelector('[data-ref="origin/main"]')).not.toBeNull();
    expect(host.querySelector('[data-ref="v1"]')).not.toBeNull();

    (host.querySelector('[data-ref="feat"]') as HTMLElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('.commit .subject')?.textContent).toContain('feat work');
  });

  it('tiles the graph rows without a vertical gap', async () => {
    const { fixture } = await render();
    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector('.commit') as HTMLElement;
    const graph = row.querySelector('.graph') as SVGElement;

    expect(graph.getAttribute('height')).toBe('26');
    expect(getComputedStyle(row).height).toBe('26px');
  });

  it('filters by text and author', async () => {
    const { fixture } = await render();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('.filter-text') as HTMLInputElement;

    text.value = 'main';
    text.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelectorAll('.commit')).toHaveLength(1);

    text.value = '';
    text.dispatchEvent(new Event('input'));
    const author = host.querySelector('.filter-author') as HTMLSelectElement;
    author.value = 'Grace';
    author.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(host.querySelectorAll('.commit')).toHaveLength(1);
    expect(host.querySelector('.commit .subject')?.textContent).toContain('docs work');
  });

  it('follows the project and drops the selected commit', async () => {
    const { fixture, fake } = await render();
    const host = fixture.nativeElement as HTMLElement;

    (host.querySelector('.commit') as HTMLElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(host.querySelector('.details')).not.toBeNull();

    fake.workspace.set({ cwd: '/other', name: 'other' });
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('.commit .subject')?.textContent).toContain('other work');
    expect(host.querySelector('.details')).toBeNull();
  });

  it('falls back to the project repo when the chosen nested one disappears', async () => {
    const { fixture, fake } = await render();
    const host = fixture.nativeElement as HTMLElement;

    const picker = host.querySelector('.repo-picker') as HTMLSelectElement;
    picker.value = 'nested';
    picker.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(host.querySelector('.commit .subject')?.textContent).toContain('nested work');

    fake.workspace.set({ cwd: '/other', name: 'other' });
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('.commit .subject')?.textContent).toContain('other work');
  });

  it('resizes the branch tree and the commit files with the layout', async () => {
    const { fixture } = await render();
    const host = fixture.nativeElement as HTMLElement;
    const layout = TestBed.inject(LayoutState);
    const tree = host.querySelector('.tree') as HTMLElement;

    expect(host.querySelector('[aria-label="Resize the branch tree"]')).not.toBeNull();
    layout.setSize('logTree', 300);
    fixture.detectChanges();
    expect(tree.style.width).toBe('300px');

    (host.querySelector('.commit') as HTMLElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('[aria-label="Resize the commit files"]')).not.toBeNull();
    layout.setSize('logDetails', 380);
    fixture.detectChanges();
    expect((host.querySelector('.details') as HTMLElement).style.width).toBe('380px');
  });

  it('shows a commit’s files in the details pane', async () => {
    const { fixture } = await render();
    const host = fixture.nativeElement as HTMLElement;

    (host.querySelector('.commit') as HTMLElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('.details')?.textContent).toContain('a.ts');
  });

  it('resets the ref and selection when the repository changes', async () => {
    const { fixture } = await render();
    const host = fixture.nativeElement as HTMLElement;

    (host.querySelector('[data-ref="feat"]') as HTMLElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(host.querySelector('.commit .subject')?.textContent).toContain('feat work');

    const picker = host.querySelector('.repo-picker') as HTMLSelectElement;
    picker.value = 'nested';
    picker.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('.commit .subject')?.textContent).toContain('nested work');
    expect(host.querySelector('.details')).toBeNull();
  });

  it('shows an error when the host cannot read the ref', async () => {
    const { fixture } = await render({ failLog: true });
    expect((fixture.nativeElement as HTMLElement).querySelector('.hint.error')?.textContent).toContain(
      'git history',
    );
  });

  it('says when the selected ref has no commits', async () => {
    const { fixture } = await render({ empty: true });
    expect((fixture.nativeElement as HTMLElement).querySelector('.empty')?.textContent).toContain(
      'No commits',
    );
  });
});

describe('projectLog', () => {
  it('links a filtered commit to its nearest visible ancestor, dashed', () => {
    const all = [commit('a', ['b']), commit('b', ['c']), commit('c', [])];
    const projected = projectLog(all, [all[0]!, all[2]!]);

    expect(projected.map((entry) => entry.hash)).toEqual(['a', 'c']);
    expect(projected[0]!.parents).toEqual(['c']);
    expect(projected[0]!.dashedParents).toEqual(['c']);
    expect(projected[1]!.parents).toEqual([]);
    expect(projected[1]!.dashedParents).toBeUndefined();
  });

  it('keeps the direct links when nothing was hidden', () => {
    const all = [commit('a', ['b']), commit('b', [])];
    const projected = projectLog(all, all);

    expect(projected[0]!.parents).toEqual(['b']);
    expect(projected[0]!.dashedParents).toBeUndefined();
  });
});
