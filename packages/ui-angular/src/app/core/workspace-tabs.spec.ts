import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerDrafts } from './composer-drafts';
import { MorseService } from './morse.service';
import { TerminalStore } from './terminal-store';
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
      { kind: 'session', id: 'draft-1', title: 'New session', cwd: '/repo', draft: true },
    ]);
    expect(tabs.activeId()).toBe('draft-1');

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

  it('abandons the draft instead of duplicating a session tab already open', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.startDraft('/repo');
    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1', 'draft-1']);

    // The user clicks the open session's tab while a draft is in front; the host
    // then lands on s1. That is not the draft's own session, so the draft goes
    // away instead of being promoted into a second tab for the same id.
    tabs.select('s1');
    tabs.showSession({ id: 's1', title: 'One', cwd: '/repo' });

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.activeId()).toBe('s1');
  });

  it('never activates the draft as if it were a pi session', () => {
    const { tabs, fake } = setup();

    tabs.startDraft('/repo');
    const draftId = tabs.tabs()[0].id;
    fake.activateSession.mockClear();

    // Clicking the "New session" tab must not ask the host to resume a session
    // literally named "draft" (pi exits: no session found matching 'draft').
    tabs.select(draftId);

    expect(tabs.activeId()).toBe(draftId);
    expect(fake.activateSession).not.toHaveBeenCalled();
  });

  it('opens a separate tab — and draft — for every "New session"', () => {
    const { tabs, fake } = setup();

    tabs.startDraft('/repo');
    tabs.startDraft('/repo');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['draft-1', 'draft-2']);
    expect(tabs.activeId()).toBe('draft-2');
    expect(fake.newSession).toHaveBeenCalledTimes(2);
  });

  it('keeps a draft with words in it when a real session is picked', () => {
    const { tabs } = setup();
    const drafts = TestBed.inject(ComposerDrafts);

    tabs.startDraft('/repo');
    const draftId = tabs.tabs()[0].id;
    drafts.use(draftId);
    drafts.setText('half a thought');

    tabs.focusSession({ id: 's1', title: 'One' });

    // The untouched-draft cleanup must not throw away what the reader typed.
    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['draft-1', 's1']);
    expect(drafts.isEmpty('draft-1')).toBe(false);
  });

  it('drops an untouched draft when a real session is picked', () => {
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

  it('moves a tab to the right of the one it is dropped on', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.focusSession({ id: 's3', title: 'Three' });

    tabs.move('s1', 's3');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s2', 's3', 's1']);
  });

  it('moves a tab to the left of the one it is dropped on', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.focusSession({ id: 's3', title: 'Three' });

    tabs.move('s3', 's1');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s3', 's1', 's2']);
  });

  it('moves a tab one step without keeping it where it was', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.focusSession({ id: 's3', title: 'Three' });

    tabs.move('s1', 's2');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s2', 's1', 's3']);
  });

  it('reorders without changing the active tab', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.select('s1');

    tabs.move('s1', 's2');

    expect(tabs.activeId()).toBe('s1');
  });

  it('refuses to reorder across the quoted-file row', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openMentionFile('a.ts');
    tabs.focusSession({ id: 's2', title: 'Two' });
    const before = tabs.tabs().map((tab) => tab.id);

    expect(tabs.canMove('s2', 'mention:s1:a.ts')).toBe(false);
    tabs.move('s2', 'mention:s1:a.ts');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(before);
  });

  it("kills a session's terminals when its tab closes", () => {
    const { tabs } = setup();
    const terminals = TestBed.inject(TerminalStore);
    tabs.focusSession({ id: 's1', title: 'One' });
    const terminal = terminals.open('s1');

    tabs.close('s1');

    expect(terminals.terminals().some((entry) => entry.id === terminal)).toBe(false);
  });

  it("moves a draft's terminals to the session it becomes", () => {
    const { tabs } = setup();
    const terminals = TestBed.inject(TerminalStore);
    tabs.startDraft('/repo');
    const draftId = tabs.tabs()[0]!.id;
    const terminal = terminals.open(draftId);

    tabs.showSession({ id: 's1', title: 'hello', cwd: '/repo' });

    expect(terminals.terminals().find((entry) => entry.id === terminal)?.owner).toBe('s1');
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

    expect(tabs.activeId()).toBe('draft-1');
  });

  it('keeps files opened from the mention picker in the active session row', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openMentionFile('docs/STATUS.md');

    expect(tabs.mainTabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.mentionTabs().map((tab) => tab.id)).toEqual(['mention:s1:docs/STATUS.md']);
  });

  it('shows only the quoted files of the session in front', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openMentionFile('a.ts');
    tabs.focusSession({ id: 's2', title: 'Two' });

    // s1's quoted file is not s2's context.
    expect(tabs.mentionTabs()).toEqual([]);

    tabs.openMentionFile('b.ts');
    expect(tabs.mentionTabs().map((tab) => tab.id)).toEqual(['mention:s2:b.ts']);

    tabs.select('s1');
    expect(tabs.mentionTabs().map((tab) => tab.id)).toEqual(['mention:s1:a.ts']);
  });

  it('keys a quoted file by session, so the same path can be quoted twice', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openMentionFile('README.md');
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.openMentionFile('README.md');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual([
      's1',
      'mention:s1:README.md',
      's2',
      'mention:s2:README.md',
    ]);
  });

  it("closes a session's quoted files with it", () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openMentionFile('a.ts');
    tabs.focusSession({ id: 's2', title: 'Two' });

    tabs.close('s1');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s2']);
  });

  it("moves a draft's quoted files to the session it becomes", () => {
    const { tabs } = setup();
    tabs.startDraft('/repo');
    const draftId = tabs.tabs()[0].id;
    tabs.openMentionFile('a.ts');
    expect(tabs.mentionTabs().map((tab) => tab.id)).toEqual([`mention:${draftId}:a.ts`]);

    tabs.showSession({ id: 's1', title: 'hello', cwd: '/repo' });

    expect(tabs.mentionTabs().map((tab) => tab.id)).toEqual(['mention:s1:a.ts']);
  });

  it("moves a draft's composer text to the session it becomes", () => {
    const { tabs } = setup();
    const drafts = TestBed.inject(ComposerDrafts);
    tabs.startDraft('/repo');
    const draftId = tabs.tabs()[0].id;
    drafts.use(draftId);
    drafts.setText('the first prompt');

    tabs.showSession({ id: 's1', title: 'hello', cwd: '/repo' });

    // The composer was editing the draft tab; its words follow the real id.
    drafts.use('s1');
    expect(drafts.text()).toBe('the first prompt');
  });

  it('opens a commit file as its own diff tab, read against the commit', async () => {
    const { tabs, fake } = setup(() => ({ path: 'a.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' }));

    tabs.openCommitFile('abc123', 'a.ts', 'A commit');
    expect(tabs.tabs()).toHaveLength(1);
    expect(tabs.tabs()[0]).toMatchObject({
      kind: 'file',
      id: 'commit:abc123:a.ts',
      path: 'a.ts',
      title: 'a.ts',
      language: 'typescript',
      loading: false,
      commitHash: 'abc123',
      commitSubject: 'A commit',
    });
    await flush();

    // It reads the commit's diff, never the working-tree content or HEAD diff.
    expect(fake.requestHostCommand).toHaveBeenCalledWith('gitCommitDiff', {
      hash: 'abc123',
      path: 'a.ts',
    });
    expect(fake.requestHostCommand).not.toHaveBeenCalledWith('readFile', expect.anything());
    expect(fake.requestHostCommand).not.toHaveBeenCalledWith('gitDiff', expect.anything());
    expect(tabs.activeTab()).toMatchObject({
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      diffLoading: false,
    });
  });
});
