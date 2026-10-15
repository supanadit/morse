import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { LayoutState } from '../../state/layout-state';
import { GitPanelState } from '../../services/git-panel-state';
import { GitPanel } from './git-panel';

/**
 * `MorseService.workspace` is a computed over the `session/state` payload, and
 * the host rebuilds that `workspace` object on every emit (`view-state.ts:108`),
 * which happens on every `agent/state` during a run. An effect that reads
 * `morse.workspace()` therefore re-runs on every token of a streaming turn — so
 * the panel must key its refresh on the project *directory*, not on the object's
 * identity, or every state emit fires another full refresh: `gitRepos` plus a
 * `gitLog`/`gitSync`/`gitStatus` per repository, all at once, against a 5s answer
 * timeout. On a project holding two dozen repositories that storm is what made
 * the panel report "The host could not read git history".
 */
describe('GitPanel refresh trigger', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.resetTestingModule());

  function mount() {
    const repos = {
      isRepo: true,
      repos: [
        { path: '', root: '/mock/workspace', name: 'morse', current: true, branch: 'main' },
      ],
    };
    // Mirrors MorseService exactly: a `view` signal whose `state.workspace` is a
    // freshly allocated object per emit, exposed through a `workspace` computed
    // that is equal by value — the same shape as the real service.
    const view = signal<{ state: { workspace: { cwd: string; name: string } } }>({
      state: { workspace: { cwd: '/mock/workspace', name: 'morse' } },
    });
    const requestHostCommand = vi.fn((command: string) =>
      Promise.resolve(
        command === 'gitRepos'
          ? repos
          : command === 'gitSync'
            ? { isRepo: true, branch: 'main', ahead: 0, behind: 0 }
            : command === 'gitStatus'
              ? { isRepo: true, files: [] }
              : { isRepo: true, root: '/mock/workspace', branch: 'main', commits: [] },
      ),
    );
    const fake = {
      // A new object identity per emit, exactly like the host's payload.
      workspace: computed(
        () => view().state.workspace,
        { equal: (a, b) => a.cwd === b.cwd && a.name === b.name },
      ),
      capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
      state: signal({ sessionId: undefined }),
      requestHostCommand,
      onActivity: () => () => undefined,
    };
    TestBed.configureTestingModule({
      imports: [GitPanel],
      providers: [{ provide: MorseService, useValue: fake }],
    });
    TestBed.inject(LayoutState).setVisible('right', true);
    const fixture = TestBed.createComponent(GitPanel);
    fixture.detectChanges();
    return { fixture, fake, view };
  }

  /** `gitRepos` calls, counted across the whole run. */
  function repoReads(fake: { requestHostCommand: ReturnType<typeof vi.fn> }): number {
    return fake.requestHostCommand.mock.calls.filter(([command]) => command === 'gitRepos').length;
  }

  it('does not re-read the repository list on every state emit', async () => {
    const { fixture, fake, view } = mount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    // The panel plus the Explorer's status poll read the list once on open.
    const afterFirst = repoReads(fake);

    // A streaming turn emits `session/state` constantly. The project has not
    // changed, so none of these may re-read the repository list.
    for (let index = 0; index < 10; index += 1) {
      view.set({ state: { workspace: { cwd: '/mock/workspace', name: 'morse' } } });
      fixture.detectChanges();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(repoReads(fake)).toBe(afterFirst);
  });

  it('does re-read the repository list when the project actually changes', async () => {
    const { fixture, fake, view } = mount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const before = repoReads(fake);

    view.set({ state: { workspace: { cwd: '/other/project', name: 'other' } } });
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A real project change does refresh: the panel's effect and the Explorer's
    // poller each re-read the list once for the new directory.
    expect(repoReads(fake)).toBeGreaterThan(before);
  });
});
