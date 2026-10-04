import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from './morse.service';
import { WorkspaceTabs } from './workspace-tabs';

type Preview = {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
};

function setup(
  handler: (command: string, args?: Record<string, unknown>) => unknown = () => undefined,
) {
  const fake = {
    // A host showing a real session: closing its tab must fall back to an draft.
    state: signal({ sessionId: 'sess-live', workspace: { cwd: '/repo', name: 'repo' } }),
    activateSession: vi.fn(),
    newSession: vi.fn(),
    requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) =>
      Promise.resolve(handler(command, args)),
    ),
  };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: fake }] });
  return { tabs: TestBed.inject(WorkspaceTabs), fake };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function preview(overrides: Partial<Preview> = {}): Preview {
  return { path: 'src/main.ts', content: 'const x = 1;\n', size: 13, truncated: false, binary: false, ...overrides };
}

describe('WorkspaceTabs', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('opens a session tab and activates that session', () => {
    const { tabs, fake } = setup();

    tabs.focusSession({ id: 's1', title: 'Morse work', cwd: '/repo' });

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.activeId()).toBe('s1');
    expect(fake.activateSession).toHaveBeenCalledWith('s1', '/repo');
  });

  it('adds a background session without stealing focus', () => {
    const { tabs } = setup();

    tabs.openFile('README.md');
    tabs.ensureSession({ id: 's1', title: 'Background run' });

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['file:README.md', 's1']);
    expect(tabs.activeId()).toBe('file:README.md');
  });

  it('reads a file once and does not re-read it on the next reveal', async () => {
    const { tabs, fake } = setup(() => preview());

    tabs.openFile('src/main.ts');
    await flush();
    expect(fake.requestHostCommand).toHaveBeenCalledTimes(1);
    expect(tabs.activeTab()).toMatchObject({ kind: 'file', content: 'const x = 1;\n', loading: false });

    // Revealing the same tab again (it was pushed behind a session) is free.
    tabs.focusSession({ id: 's1', title: 'One' });
    fake.requestHostCommand.mockClear();
    tabs.openFile('src/main.ts');
    await flush();
    expect(fake.requestHostCommand).not.toHaveBeenCalled();
    expect(tabs.activeId()).toBe('file:src/main.ts');
  });

  it('reports a read failure on the tab instead of hanging in loading', async () => {
    const { tabs } = setup(() => undefined);

    tabs.openFile('binary.png');
    await flush();

    expect(tabs.activeTab()).toMatchObject({ loading: false, error: 'Could not read this file.' });
  });

  it('falls back to the neighbour and reactivates it when a session tab closes', () => {
    const { tabs, fake } = setup();

    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    fake.activateSession.mockClear();

    tabs.close('s2');

    expect(tabs.activeId()).toBe('s1');
    expect(fake.activateSession).toHaveBeenCalledWith('s1', undefined);
  });

  it('does not activate a file tab', () => {
    const { tabs, fake } = setup();

    tabs.openFile('README.md');
    fake.activateSession.mockClear();
    tabs.select('file:README.md');

    expect(fake.activateSession).not.toHaveBeenCalled();
  });

  it('selecting a session tab activates it', () => {
    const { tabs, fake } = setup();

    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('README.md');
    fake.activateSession.mockClear();

    tabs.select('s1');

    expect(tabs.activeId()).toBe('s1');
    expect(fake.activateSession).toHaveBeenCalledWith('s1', undefined);
  });

  it('opens a draft tab for a new session and promotes it when the id arrives', () => {
    const { tabs, fake } = setup();

    tabs.startDraft('/repo');
    expect(fake.newSession).toHaveBeenCalledWith('/repo');
    expect(tabs.tabs()).toEqual([
      { kind: 'session', id: 'draft', title: 'New session', cwd: '/repo', draft: true },
    ]);
    expect(tabs.activeId()).toBe('draft');

    // The first prompt gives the draft its real id: the tab becomes that session
    // in place, not a second tab beside an orphaned draft.
    tabs.showSession({ id: 's1', title: 'hello', cwd: '/repo' });
    expect(tabs.tabs()).toEqual([{ kind: 'session', id: 's1', title: 'hello', cwd: '/repo' }]);
    expect(tabs.activeId()).toBe('s1');
  });

  it('abandons an unfinished draft when a real session is picked', () => {
    const { tabs } = setup();

    tabs.startDraft('/repo');
    tabs.focusSession({ id: 's1', title: 'One' });

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
  });

  it('refreshes a title but never resurrects a closed tab', () => {
    const { tabs } = setup();

    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.close('s1');
    expect(tabs.tabs()).toEqual([]);

    // The host keeps re-emitting the same session after the tab was closed.
    tabs.refreshSession({ id: 's1', title: 'One renamed' });
    expect(tabs.tabs()).toEqual([]);

    // …while an open tab still picks the new title up.
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.refreshSession({ id: 's1', title: 'One renamed' });
    expect(tabs.tabs()[0]).toMatchObject({ title: 'One renamed' });
  });

  it('sends the host back to an empty session when the last session tab closes', () => {
    const { tabs, fake } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    fake.newSession.mockClear();

    tabs.close('s1');

    expect(tabs.tabs()).toEqual([]);
    expect(tabs.activeId()).toBeUndefined();
    // Not just an empty strip: the panel must stop showing the closed session.
    expect(fake.newSession).toHaveBeenCalledWith('/repo');
  });

  it('does not reset the host when a background session tab closes', () => {
    const { tabs, fake } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/repo' });
    fake.newSession.mockClear();

    tabs.close('s1');

    expect(fake.newSession).not.toHaveBeenCalled();
    expect(tabs.activeId()).toBe('s2');
  });

  it('keeps only the target with closeOthers and activates it', () => {
    const { tabs, fake } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/repo' });
    tabs.openFile('README.md');
    fake.activateSession.mockClear();

    tabs.closeOthers('s1');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.activeId()).toBe('s1');
    expect(fake.activateSession).toHaveBeenCalledWith('s1', '/repo');
  });

  it('closes only the tabs to the right', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.focusSession({ id: 's3', title: 'Three' });
    tabs.select('s1');

    tabs.closeToTheRight('s1');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.activeId()).toBe('s1');
  });

  it('empties the strip and the host with closeAll', () => {
    const { tabs, fake } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.openFile('README.md');
    fake.newSession.mockClear();

    tabs.closeAll();

    expect(tabs.tabs()).toEqual([]);
    expect(tabs.activeId()).toBeUndefined();
    expect(fake.newSession).toHaveBeenCalledWith('/repo');
  });

  it('forgets a tab the host was told to close, without sending actions', () => {
    const { tabs, fake } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    fake.activateSession.mockClear();
    fake.newSession.mockClear();

    tabs.forget('s2');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    // The caller owns the `session/close`; forgetting must not add another action.
    expect(fake.activateSession).toHaveBeenCalledWith('s1', undefined);
    expect(fake.newSession).not.toHaveBeenCalled();
  });

  it('clears an active session tab when the host drops to a draft', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    expect(tabs.activeId()).toBe('s1');

    tabs.clearActiveSession();

    // The stale tab stays in the strip, but nothing claims to be on screen.
    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.activeId()).toBeUndefined();
  });

  it('keeps a draft tab active while the host is on a draft', () => {
    const { tabs } = setup();
    tabs.startDraft('/repo');

    tabs.clearActiveSession();

    expect(tabs.activeId()).toBe('draft');
  });
});
