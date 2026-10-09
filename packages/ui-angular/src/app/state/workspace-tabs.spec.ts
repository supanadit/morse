import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerDrafts } from './composer-drafts';
import { MorseService } from '../host/morse.service';
import { QueuedPrompts } from './queued-prompts';
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
  capabilities: { filePreview?: boolean; promptEditor?: boolean } = {},
) {
  const fake = {
    // A host showing a real session: closing its tab must fall back to an draft.
    state: signal<{ sessionId?: string; workspace: { cwd: string; name: string } }>({
      sessionId: 'sess-live',
      workspace: { cwd: '/repo', name: 'repo' },
    }),
    // The capabilities the shell reads to choose an editor surface; the browser
    // shape is the default, so `openPromptEditor` opens a tab here.
    capabilities: signal<{ filePreview?: boolean; promptEditor?: boolean }>({
      filePreview: true,
      promptEditor: true,
      ...capabilities,
    }),
    activateSession: vi.fn(),
    newSession: vi.fn(),
    closeTerminal: vi.fn(),
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

/** The ids of the quoted-file chips in the strip, in row order. */
function mentionIds(tabs: WorkspaceTabs): string[] {
  return tabs
    .tabs()
    .filter((tab) => tab.kind === 'file' && tab.mention === true)
    .map((tab) => tab.id);
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

  it('opens one MCP editor tab and re-focuses it instead of stacking a second', () => {
    const { tabs } = setup();

    tabs.openMcp();
    tabs.openFile('README.md');
    tabs.openMcp();

    expect(tabs.tabs().filter((tab) => tab.kind === 'mcp')).toHaveLength(1);
    expect(tabs.activeId()).toBe('mcp:servers');
  });

  it('opens one prompt editor tab and re-focuses it instead of stacking a second', () => {
    const { tabs } = setup();

    tabs.openPrompt();
    tabs.openFile('README.md');
    tabs.openPrompt();

    expect(tabs.tabs().filter((tab) => tab.kind === 'prompt')).toHaveLength(1);
    expect(tabs.activeId()).toBe('prompt:templates');
  });

  it('opens the prompt editor as a tab on a host with a tab strip', () => {
    const { tabs, fake } = setup(() => undefined, { filePreview: true });

    tabs.openPromptEditor();

    expect(tabs.activeId()).toBe('prompt:templates');
    expect(fake.requestHostCommand).not.toHaveBeenCalledWith('openPromptEditor', expect.anything());
  });

  it('asks the host to open its own editor panel where there is no tab strip', () => {
    const { tabs, fake } = setup(() => undefined, { filePreview: false });

    tabs.openPromptEditor();

    expect(tabs.tabs().some((tab) => tab.kind === 'prompt')).toBe(false);
    expect(fake.requestHostCommand).toHaveBeenCalledWith('openPromptEditor', {});
  });

  it('reads a file once and does not re-read it on the next reveal', async () => {
    const { tabs, fake } = setup(() => preview());

    tabs.openFile('src/main.ts');
    await flush();
    expect(fake.requestHostCommand).toHaveBeenCalledTimes(1);
    expect(tabs.activeTab()).toMatchObject({ kind: 'file', content: 'const x = 1;\n', loading: false });

    // Re-opening it under a session moves it into that session's chip row, and
    // the move does not re-read the file.
    tabs.focusSession({ id: 's1', title: 'One' });
    fake.requestHostCommand.mockClear();
    tabs.openFile('src/main.ts');
    await flush();
    expect(fake.requestHostCommand).not.toHaveBeenCalled();
    expect(tabs.activeId()).toBe('mention:s1:src/main.ts');
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

  it('returns to the chip’s own session when the chip in front closes', () => {
    const { tabs, fake } = setup();

    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('a.ts');
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.openFile('b.ts');
    expect(tabs.activeId()).toBe('mention:s2:b.ts');
    fake.activateSession.mockClear();

    tabs.close('mention:s2:b.ts');

    // The chip is s2's context, so closing it goes back to s2 — not to s1's
    // chip, which is what the positional neighbour would have been.
    expect(tabs.activeId()).toBe('s2');
    expect(fake.activateSession).toHaveBeenCalledWith('s2', undefined);
    expect(tabs.tabs().some((tab) => tab.id === 'mention:s1:a.ts')).toBe(true);
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

  it('keeps an untouched draft alive while it holds a terminal', () => {
    const { tabs, fake } = setup();
    const terminals = TestBed.inject(TerminalStore);

    tabs.startDraft('/repo');
    const draftId = tabs.tabs()[0]!.id;
    const terminal = terminals.open(draftId);

    // Picking a real session used to discard the untouched draft and its shell
    // with it, losing a terminal the reader had already `cd`'d in.
    tabs.focusSession({ id: 's1', title: 'One' });

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['draft-1', 's1']);
    expect(terminals.terminals().map((entry) => entry.id)).toEqual([terminal]);
    expect(fake.closeTerminal).not.toHaveBeenCalled();
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
    const { tabs, fake } = setup();
    const terminals = TestBed.inject(TerminalStore);
    tabs.focusSession({ id: 's1', title: 'One' });
    const terminal = terminals.open('s1');

    tabs.close('s1');

    expect(terminals.terminals().some((entry) => entry.id === terminal)).toBe(false);
    // The layout is gone, and the host-owned shell ends with it — an explicit
    // `terminal/close`, never the component unmounting.
    expect(fake.closeTerminal).toHaveBeenCalledWith(terminal);
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

  it("drops a session's queued follow-ups when its tab closes", () => {
    const { tabs } = setup();
    const queue = TestBed.inject(QueuedPrompts);
    tabs.focusSession({ id: 's1', title: 'One' });
    queue.enqueue({ text: 'later', images: [], pins: [] }, 's1');

    tabs.close('s1');

    expect(queue.forOwner('s1')).toEqual([]);
  });

  it("moves a draft's queued follow-ups to the session it becomes", () => {
    const { tabs } = setup();
    const queue = TestBed.inject(QueuedPrompts);
    tabs.startDraft('/repo');
    const draftId = tabs.tabs()[0]!.id;
    queue.enqueue({ text: 'later', images: [], pins: [] }, draftId);

    tabs.showSession({ id: 's1', title: 'hello', cwd: '/repo' });

    expect(queue.forOwner('s1').map((item) => item.text)).toEqual(['later']);
    expect(queue.forOwner(draftId)).toEqual([]);
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

  /**
   * A chip is context for its session, so the chip-row close actions land back in
   * that conversation — never on whichever tab happens to sit last in the strip.
   */
  it('returns to the owning session when Close All empties a chip row', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.select('s1');
    tabs.openMentionFile('a.ts');
    tabs.openMentionFile('b.ts');
    const chips = mentionIds(tabs);
    // The chip just opened is in front, the way the menu is opened on one.
    expect(tabs.activeId()).toBe(chips[1]);

    tabs.closeAll(chips[0]!);

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1', 's2']);
    // Back to s1 (the chips' session), not to the last session tab (s2).
    expect(tabs.activeId()).toBe('s1');
  });

  it('keeps the clicked chip and its session with Close Others', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.select('s1');
    tabs.openMentionFile('a.ts');
    tabs.openMentionFile('b.ts');
    const chips = mentionIds(tabs);

    tabs.closeOthers(chips[0]!);

    expect(mentionIds(tabs)).toEqual([chips[0]]);
    expect(tabs.activeId()).toBe(chips[0]);
    expect(tabs.tabs().some((tab) => tab.id === 's2')).toBe(true);
  });

  it('returns to the clicked chip when Close to the Right removes the one in front', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.select('s1');
    tabs.openMentionFile('a.ts');
    tabs.openMentionFile('b.ts');
    tabs.openMentionFile('c.ts');
    const chips = mentionIds(tabs);
    tabs.select(chips[1]!);

    tabs.closeToTheRight(chips[0]!);

    expect(mentionIds(tabs)).toEqual([chips[0]]);
    expect(tabs.activeId()).toBe(chips[0]);
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

  it('keeps a file opened under a session attached to that session', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/work/morse' });
    tabs.openFile('a.ts');

    // A file opened while s1 is in front is s1's chip — not a tab beside the
    // sessions — and it carries the project it was read from.
    expect(tabs.activeTab()).toMatchObject({ mention: true, sessionId: 's1', projectCwd: '/work/morse' });
    expect(tabs.mentionTabs().map((tab) => tab.id)).toEqual(['mention:s1:a.ts']);
    expect(tabs.mainTabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.composerKey()).toBe('s1');

    // Picking its chip back up keeps the composer with s1.
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/work/morse' });
    tabs.select('mention:s1:a.ts');
    expect(tabs.composerKey()).toBe('s1');
  });

  it('gives each session its own chip for the same path', async () => {
    const { tabs } = setup(() => preview());
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/one' });
    tabs.openFile('a.ts');
    await flush();
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/two' });

    tabs.openFile('a.ts');
    await flush();

    // A chip is keyed by its session, so another session's copy is its own —
    // read against its own project.
    expect(tabs.activeTab()).toMatchObject({ mention: true, sessionId: 's2', projectCwd: '/two' });
    expect(tabs.composerKey()).toBe('s2');
    expect(tabs.tabs().map((tab) => tab.id)).toEqual([
      's1',
      'mention:s1:a.ts',
      's2',
      'mention:s2:a.ts',
    ]);
  });

  it('closes a file chip with the session it belongs to', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.openFile('a.ts');
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/repo' });
    tabs.select('mention:s1:a.ts');

    tabs.close('s1');

    // The chip is the session's, so it goes with its tab — and the panel falls
    // back to the session still open rather than to nothing.
    expect(tabs.tabs().some((tab) => tab.id === 'mention:s1:a.ts')).toBe(false);
    expect(tabs.composerKey()).toBe('s2');
  });

  it('clicking the chip already in front goes back to its session', () => {
    const { tabs, fake } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.openFile('a.ts');
    expect(tabs.activeId()).toBe('mention:s1:a.ts');
    fake.activateSession.mockClear();

    // A second click means "show me the chat again", not a no-op.
    tabs.select('mention:s1:a.ts');

    expect(tabs.activeId()).toBe('s1');
    expect(fake.activateSession).toHaveBeenCalledWith('s1', '/repo');
  });

  it('a standalone file has no session to return to, so a second click stays', () => {
    const { tabs, fake } = setup();
    tabs.openFile('a.ts');
    expect(tabs.activeId()).toBe('file:a.ts');
    fake.activateSession.mockClear();

    tabs.select('file:a.ts');

    expect(tabs.activeId()).toBe('file:a.ts');
    expect(fake.activateSession).not.toHaveBeenCalled();
  });

  it('attaches a commit diff chip to the session in front', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });

    tabs.openCommitFile('abc123', 'a.ts', 'A commit');

    expect(tabs.activeTab()).toMatchObject({ mention: true, sessionId: 's1', projectCwd: '/repo' });
    expect(tabs.mentionTabs().map((tab) => tab.id)).toEqual(['mention:s1:commit:abc123:a.ts']);
    expect(tabs.composerKey()).toBe('s1');

    // Another session's copy is its own chip, read against its own project.
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/other' });
    tabs.openCommitFile('abc123', 'a.ts', 'A commit');
    expect(tabs.activeTab()).toMatchObject({ mention: true, sessionId: 's2', projectCwd: '/other' });
    expect(tabs.composerKey()).toBe('s2');
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
      cwd: '/repo',
    });
    expect(fake.requestHostCommand).not.toHaveBeenCalledWith('readFile', expect.anything());
    expect(fake.requestHostCommand).not.toHaveBeenCalledWith('gitDiff', expect.anything());
    expect(tabs.activeTab()).toMatchObject({
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      diffLoading: false,
    });
  });

  it('snapshots the open tabs and the front one, a draft tab included', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.openFile('README.md');
    tabs.startDraft('/repo');
    tabs.openMentionFile('a.ts');

    const snapshot = tabs.snapshot();

    // A "New session" tab keeps its place (the prompt lives in the saved drafts),
    // but the file quoted inside it does not: a draft owns no session context.
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(['s1', 'mention:s1:README.md', 'draft-1']);
    expect(snapshot.tabs.find((tab) => tab.id === 'draft-1')).toEqual({
      kind: 'session',
      id: 'draft-1',
      title: 'New session',
      cwd: '/repo',
      draft: true,
    });
    // A preview's content is read again, never written to the layout — but the
    // session it was opened under is, so it comes back as that session's chip.
    expect(snapshot.tabs.find((tab) => tab.id === 'mention:s1:README.md')).toEqual({
      kind: 'file',
      id: 'mention:s1:README.md',
      path: 'README.md',
      title: 'README.md',
      language: 'markdown',
      projectCwd: '/repo',
      mention: true,
      sessionId: 's1',
    });
  });

  it('keeps the one MCP editor tab across a snapshot and restore', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    tabs.openMcp();

    const snapshot = tabs.snapshot();
    expect(snapshot.tabs.find((tab) => tab.id === 'mcp:servers')).toEqual({
      kind: 'mcp',
      id: 'mcp:servers',
      title: 'MCP servers',
    });
    expect(snapshot.activeId).toBe('mcp:servers');

    TestBed.resetTestingModule();
    const { tabs: restored } = setup();
    restored.restore(snapshot);
    expect(restored.tabs().map((tab) => tab.id)).toEqual(['s1', 'mcp:servers']);
    expect(restored.activeTab()?.kind).toBe('mcp');
  });

  it('restores a New session draft and promotes it on the first prompt', () => {
    const { tabs, fake } = setup();
    tabs.restore({
      tabs: [{ kind: 'session', id: 'draft-2', title: 'New session', cwd: '/repo', draft: true }],
      activeId: 'draft-2',
    });

    // The host reattaching a session must not consume the draft before it is sent.
    tabs.showSession({ id: 's1', title: 'One', cwd: '/repo' });
    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['draft-2', 's1']);
    expect(tabs.activeId()).toBe('draft-2');
    fake.activateSession.mockClear();

    // The first prompt opens a session, and the draft becomes that session in place.
    tabs.showSession({ id: 's9', title: 'hello', cwd: '/repo' });
    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s9', 's1']);
    expect(tabs.activeId()).toBe('s9');
    expect(fake.activateSession).not.toHaveBeenCalled();
  });

  it('does not reuse a restored draft id for a new session', () => {
    const { tabs } = setup();
    tabs.restore({
      tabs: [{ kind: 'session', id: 'draft-3', title: 'New session', draft: true }],
    });

    tabs.startDraft('/repo');

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['draft-3', 'draft-4']);
  });

  it('restores the tabs and the front one, re-reading a file in front', async () => {
    const { tabs, fake } = setup(() => preview());

    tabs.restore({
      tabs: [
        { kind: 'session', id: 's1', title: 'One', cwd: '/repo' },
        { kind: 'file', id: 'file:a.ts', path: 'a.ts', title: 'a.ts', language: 'typescript', projectCwd: '/repo' },
      ],
      activeId: 'file:a.ts',
    });
    await flush();

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1', 'file:a.ts']);
    expect(tabs.activeId()).toBe('file:a.ts');
    // The front file is read again, so the preview is the disk, not a memory.
    expect(fake.requestHostCommand).toHaveBeenCalledWith('readFile', { path: 'a.ts', cwd: '/repo' });
    expect(tabs.activeTab()).toMatchObject({ kind: 'file', content: 'const x = 1;\n' });
  });

  it('keeps a restored file in front when the host reattaches its session', () => {
    const { tabs, fake } = setup();
    tabs.restore({
      tabs: [
        { kind: 'session', id: 's1', title: 'One', cwd: '/repo' },
        { kind: 'file', id: 'file:a.ts', path: 'a.ts', title: 'a.ts' },
      ],
      activeId: 'file:a.ts',
    });
    fake.activateSession.mockClear();

    tabs.showSession({ id: 's2', title: 'Two', cwd: '/repo' });

    // s2 joins the strip, but the file the reader left on stays in front.
    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1', 'file:a.ts', 's2']);
    expect(tabs.activeId()).toBe('file:a.ts');
    expect(fake.activateSession).not.toHaveBeenCalled();
  });

  it('asks the host for a restored session that is not the reattached one', () => {
    const { tabs, fake } = setup();
    tabs.restore({
      tabs: [
        { kind: 'session', id: 's1', title: 'One', cwd: '/repo' },
        { kind: 'session', id: 's2', title: 'Two', cwd: '/repo' },
      ],
      activeId: 's2',
    });
    fake.activateSession.mockClear();

    tabs.showSession({ id: 's1', title: 'One', cwd: '/repo' });

    expect(tabs.activeId()).toBe('s2');
    expect(fake.activateSession).toHaveBeenCalledWith('s2', '/repo');
  });

  it('does not clear a restored front tab while the host is on an empty draft', () => {
    const { tabs } = setup();
    tabs.restore({
      tabs: [{ kind: 'session', id: 's1', title: 'One', cwd: '/repo' }],
      activeId: 's1',
    });

    tabs.clearActiveSession();

    expect(tabs.activeId()).toBe('s1');
  });

  it('ignores a layout it cannot read', () => {
    const { tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });

    // A malformed snapshot leaves the strip exactly as it was.
    tabs.restore({ tabs: 'not-an-array' });

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(tabs.activeId()).toBe('s1');
  });
});
