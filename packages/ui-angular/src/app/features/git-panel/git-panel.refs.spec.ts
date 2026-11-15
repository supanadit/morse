import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { LayoutState } from '../../state/layout-state';
import { GitPanel } from './git-panel';

/** Mirrors `WorkspaceFiles`' poll interval: the timer is what this test drives. */
const POLL_MS = 4_000;

/**
 * A branch created, deleted or checked out by *another* git client — `lazygit` in
 * a second terminal, which is the case the task was filed for — moves nothing in
 * the working tree. The polled `gitStatus` carries a refs fingerprint for
 * exactly that: the panel re-reads the branch list, the distance from upstream
 * and the history when it moves, and does nothing while it does not.
 */
describe('GitPanel branch list freshness', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function mount(options: { status?: () => unknown } = {}) {
    const repos = {
      isRepo: true,
      repos: [{ path: '', root: '/mock/workspace', name: 'morse', current: true, branch: 'main' }],
    };
    /** The refs fingerprint the host reports; a test moves it like git would. */
    const refs = signal('refs-a');
    /** The branch HEAD points at, read on the same poll. */
    const branch = signal('main');
    const requestHostCommand = vi.fn((command: string): Promise<unknown> =>
      Promise.resolve(
        options.status !== undefined && command === 'gitStatus'
          ? options.status()
          : command === 'gitRepos'
            ? repos
            : command === 'listFiles'
              ? { files: [] }
              : command === 'gitSync'
                ? { isRepo: true, branch: branch(), ahead: 0, behind: 0 }
                : command === 'gitStatus'
                  ? { isRepo: true, files: [], branch: branch(), refs: refs() }
                  : command === 'gitBranches'
                    ? {
                        isRepo: true,
                        current: branch(),
                        local: [branch()],
                        remote: [],
                        tags: [],
                      }
                    : { isRepo: true, root: '/mock/workspace', branch: branch(), commits: [] },
      ),
    );
    const fake = {
      workspace: signal({ cwd: '/mock/workspace', name: 'morse' }),
      capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
      state: signal({ sessionId: undefined }),
      requestHostCommand,
    };
    TestBed.configureTestingModule({
      imports: [GitPanel],
      providers: [{ provide: MorseService, useValue: fake }],
    });
    TestBed.inject(LayoutState).setVisible('right', true);
    const fixture = TestBed.createComponent(GitPanel);
    fixture.detectChanges();
    return { fixture, fake, refs, branch };
  }

  /** Lets the answers behind a poll land, and flushes the effects they move. */
  async function settle(fixture: ReturnType<typeof mount>['fixture']): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    TestBed.tick();
    fixture.detectChanges();
  }

  /** Runs one poll tick of the shared `WorkspaceFiles` timer. */
  async function tick(fixture: ReturnType<typeof mount>['fixture']): Promise<void> {
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settle(fixture);
  }

  function reads(fake: ReturnType<typeof mount>['fake'], command: string): number {
    return fake.requestHostCommand.mock.calls.filter(([name]) => name === command).length;
  }

  it('re-reads the branch list when the refs fingerprint moves', async () => {
    const { fixture, fake, refs, branch } = mount();
    await settle(fixture);
    // The panel opens on the repository without a branch list: the picker asks
    // for that when it opens.
    expect(reads(fake, 'gitBranches')).toBe(0);
    const logs = reads(fake, 'gitLog');

    // `lazygit` created a branch and checked it out in another terminal.
    refs.set('refs-b');
    branch.set('feat');
    await tick(fixture);

    expect(reads(fake, 'gitBranches')).toBeGreaterThan(0);
    expect(reads(fake, 'gitLog')).toBeGreaterThan(logs);
    // The chip follows the same poll, without waiting for a history read.
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.branch-name')?.textContent?.trim()).toBe('feat');
  });

  it('leaves a quiet repository alone', async () => {
    const { fixture, fake } = mount();
    await settle(fixture);
    const logs = reads(fake, 'gitLog');

    for (let round = 0; round < 3; round += 1) {
      await tick(fixture);
    }

    expect(reads(fake, 'gitBranches')).toBe(0);
    expect(reads(fake, 'gitLog')).toBe(logs);
  });

  it('does not re-read for a host that reports no fingerprint', async () => {
    // An older host: `gitStatus` without `refs`, so nothing may be re-read.
    const { fixture, fake } = mount({ status: () => ({ isRepo: true, files: [] }) });
    await settle(fixture);

    for (let round = 0; round < 3; round += 1) {
      await tick(fixture);
    }

    expect(reads(fake, 'gitBranches')).toBe(0);
  });
});
