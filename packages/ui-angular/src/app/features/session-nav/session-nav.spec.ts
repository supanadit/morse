import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, vi } from 'vitest';
import { FRONTEND_IDENTITY } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ShellState } from '../../state/shell-state';
import { LayoutState } from '../../state/layout-state';
import { OverlayStack } from '../../state/overlay-stack';
import { ShortcutService } from '../../services/shortcut.service';
import { ShortcutKeys } from '../../ui/shortcut-keys';
import { UPDATE_LOADER, type VersionLoader } from '../../services/update';
import { SessionNav } from './session-nav';

/**
 * Fake host that reports a given scope and only the data a real host of that
 * scope would send, so the navigation's two shapes are locked:
 *
 * - `global` (browser host): sessions grouped by project.
 * - `workspace` (VS Code): a single group, no project switcher.
 */
class ScopedHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  /** Everything the nav sent, so a test can assert the action it triggered. */
  readonly sent: ClientToHostMessage[] = [];

  constructor(
    private readonly scope: 'global' | 'workspace',
    private readonly directoryPicker = false,
    private readonly updateCheck = false,
    /** The host shows a session as its own editor tab (VS Code). */
    private readonly sessionTabs = false,
    /** Sessions to send, when a test needs a shape the default pair cannot show (a fork). */
    private readonly sessions?: {
      id: string;
      title: string;
      cwd: string;
      updatedAt: number;
      messageCount: number;
      parentId?: string;
    }[],
  ) {
    super();
  }

  connect(): void {
    this.emitStatus('open');
  }

  send(message: ClientToHostMessage): void {
    this.sent.push(message);
    if (message.type !== 'client/ready') {
      return;
    }
    const scoped = this.scope === 'workspace';
    this.emitMessage({
      type: 'host/ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          hostKind: scoped ? 'vscode' : 'server',
          scope: this.scope,
          editorContext: scoped,
          nativeDialogs: scoped,
          insertIntoEditor: false,
          revealFile: false,
          directoryPicker: this.directoryPicker,
          updateCheck: this.updateCheck,
          sessionTabs: this.sessionTabs,
        },
        state: {
          workspace: { cwd: '/work/morse', name: 'morse' },
          thinkingLevel: 'off',
          availableModels: [],
          availableThinkingLevels: [],
          availableCommands: [],
          streaming: false,
          busy: false,
          agentReady: true,
          agentStarting: false,
        },
      },
    });
    this.emitMessage({
      type: 'project/list',
      payload: {
        projects: scoped
          ? [{ path: '/work/morse', name: 'morse', sessionCount: 1, lastUsedAt: 2 }]
          : [
              { path: '/work/morse', name: 'morse', sessionCount: 1, lastUsedAt: 2 },
              { path: '/work/other', name: 'other', sessionCount: 1, lastUsedAt: 1 },
            ],
      },
    });
    this.emitMessage({
      type: 'session/list',
      payload: {
        sessions:
          this.sessions ??
          (scoped
            ? [{ id: 's1', title: 'Morse work', cwd: '/work/morse', updatedAt: 2, messageCount: 3 }]
            : [
                { id: 's1', title: 'Morse work', cwd: '/work/morse', updatedAt: 2, messageCount: 3 },
                { id: 's2', title: 'Other work', cwd: '/work/other', updatedAt: 1, messageCount: 5 },
              ]),
      },
    });
    // Two live sessions; only `s1` is actually running, `s2` is idle.
    this.emitMessage({
      type: 'session/activity',
      payload: {
        sessions: [
          {
            sessionKey: 's1',
            streaming: true,
            busy: false,
            agentReady: true,
            agentStarting: false,
          },
          {
            sessionKey: 's2',
            streaming: false,
            busy: false,
            agentReady: true,
            agentStarting: false,
          },
        ],
      },
    });
  }

  /**
   * The host spawned `sessionKey`'s agent because the session was just opened:
   * no turn is running, only `agentStarting` flips for a beat.
   */
  openSession(sessionKey: string): void {
    this.emitMessage({
      type: 'session/activity',
      payload: {
        sessions: [
          {
            sessionKey: 's1',
            streaming: true,
            busy: false,
            agentReady: true,
            agentStarting: false,
          },
          {
            sessionKey,
            streaming: false,
            busy: false,
            agentReady: false,
            agentStarting: true,
          },
        ],
      },
    });
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

/** What a test needs beyond the scope: whether the host allows the release check. */
interface RenderOptions {
  updateCheck?: boolean;
  loader?: VersionLoader;
  /** The host shows a session as its own editor tab (VS Code). */
  sessionTabs?: boolean;
  /** Sessions to send, when a test needs a shape the default pair cannot show (a fork). */
  sessions?: {
    id: string;
    title: string;
    cwd: string;
    updatedAt: number;
    messageCount: number;
    parentId?: string;
  }[];
}

async function render(
  scope: 'global' | 'workspace',
  directoryPicker = false,
  options: RenderOptions = {},
): Promise<{ host: HTMLElement; transport: ScopedHostTransport; fixture: ComponentFixture<SessionNav> }> {
  TestBed.resetTestingModule();
  const transport = new ScopedHostTransport(
    scope,
    directoryPicker,
    options.updateCheck === true,
    options.sessionTabs === true,
    options.sessions,
  );
  await TestBed.configureTestingModule({
    imports: [SessionNav],
    providers: [
      { provide: MORSE_TRANSPORT, useFactory: () => transport },
      // Never the real loader: a test must not be able to reach the registry.
      { provide: UPDATE_LOADER, useValue: options.loader },
    ],
  }).compileComponents();

  // The DOM half of the keyboard: the same injection the app makes, so a press on
  // the document reaches the registry.
  TestBed.inject(ShortcutKeys);

  const fixture = TestBed.createComponent(SessionNav);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, transport, fixture };
}

/** Presses a shortcut the way the shell sees it: on the document, capture included. */
function press(key: string, { ctrl = false, alt = false } = {}): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, ctrlKey: ctrl, altKey: alt, bubbles: true, cancelable: true }),
  );
}

/** jsdom has no layout, so every box is 0×0 — which reads as off canvas; say otherwise. */
function show(element: HTMLElement): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 20, width: 120, height: 20 };
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ ...rect, toJSON: () => rect }),
    configurable: true,
  });
}

function footButton(host: HTMLElement, label: string): HTMLElement {
  const button = [...host.querySelectorAll('.foot button')].find((candidate) =>
    (candidate.textContent ?? '').includes(label),
  );
  if (button === undefined) {
    throw new Error(`no footer button labelled ${label}`);
  }
  return button as HTMLElement;
}

describe('SessionNav', () => {
  // This suite folds the sidebar column, and the fold is remembered in `localStorage`. The
  // environment is shared with the other suites, so leaving it set would break whichever one
  // ran next — a test that depends on what the last file left behind is not a test.
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('groups sessions by project for a global host', async () => {
    const { host } = await render('global');
    const text = host.textContent ?? '';

    // Every project is a group row in the shared tree, drawn the way the Explorer draws
    // a folder: a fold chevron, the name, a count badge.
    expect(host.querySelectorAll('.row.group')).toHaveLength(2);
    expect(text).toContain('morse');
    expect(text).toContain('other');
    expect(text).toContain('Morse work');
    expect(text).toContain('Other work');
    // The per-project action lives on the project's own row as a "+" icon.
    expect(host.querySelectorAll('.row-action')).toHaveLength(2);
    expect(host.querySelector('.row-action')?.getAttribute('aria-label')).toContain('morse');
  });

  it('nests a forked session under the session it was forked from', async () => {
    const { host } = await render('global', false, {
      sessions: [
        { id: 'parent', title: 'Use codebase map memory', cwd: '/work/morse', updatedAt: 2, messageCount: 3 },
        { id: 'fork', title: 'Use codebase map memory', cwd: '/work/morse', updatedAt: 1, messageCount: 1, parentId: 'parent' },
      ],
    });

    // The parent is a foldable group (it holds a fork); the fork is a `└─` under it,
    // the way a subdirectory is under a folder. Level 1 is the project, 2 the parent.
    const parent = host.querySelector('[aria-level="2"]') as HTMLElement;
    expect(parent.querySelector('.label')?.textContent).toContain('Use codebase map memory');
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    const fork = host.querySelector('[aria-level="3"]') as HTMLElement;
    expect(fork.querySelector('.label')?.textContent).toContain('Use codebase map memory');
    // One gap for the project root, one for the parent, then the corner.
    expect(fork.querySelector('.prefix')?.textContent).toBe(' └');
    expect(fork.getAttribute('aria-level')).toBe('3');
  });

  it('opens a parent session from its name, and folds it from its caret', async () => {
    const { host, transport, fixture } = await render('global', false, {
      sessions: [
        { id: 'parent', title: 'Parent session', cwd: '/work/morse', updatedAt: 2, messageCount: 3 },
        { id: 'fork', title: 'Forked session', cwd: '/work/morse', updatedAt: 1, messageCount: 1, parentId: 'parent' },
      ],
    });

    // A parent is a session first: clicking its name opens it, like any other row.
    const parentRow = host.querySelector('.row[aria-level="2"]') as HTMLElement;
    parentRow.click();
    fixture.detectChanges();
    expect(
      transport.sent.some((m) => m.type === 'session/activate'),
    ).toBe(true);

    // Its caret only folds — the row behind it does not open.
    const caret = host.querySelector('button.chevron[aria-expanded="true"]') as HTMLButtonElement;
    expect(caret).not.toBeNull();
    caret.click();
    fixture.detectChanges();
    // Folded, the fork is gone from the list.
    expect(host.querySelectorAll('.row[aria-level="3"]')).toHaveLength(0);
  });

  it('leaves a fork a root when the session it was forked from is not in the list', async () => {
    const { host } = await render('global', false, {
      // The parent is missing (deleted, or pinned as in progress): the child must
      // still be reachable rather than hidden under a row that is not there.
      sessions: [
        { id: 'fork', title: 'Orphaned fork', cwd: '/work/morse', updatedAt: 1, messageCount: 1, parentId: 'gone' },
      ],
    });

    // The orphan is a root session, so it sits one level under the project.
    const fork = host.querySelector('[aria-level="2"]') as HTMLElement;
    expect(fork.querySelector('.label')?.textContent).toBe('Orphaned fork');
    expect(fork.classList.contains('group')).toBe(false);
    expect(fork.querySelector('.prefix')?.textContent).toBe('└');
  });

  it('shows one group and no project switcher for a workspace-scoped host', async () => {
    const { host } = await render('workspace');
    const text = host.textContent ?? '';

    // One project means the group header (and its accordion) is noise.
    expect(host.querySelectorAll('.row.group')).toHaveLength(0);
    expect(text).toContain('Morse work');
    expect(text).not.toContain('Other work');
    // Creating a session in *another* directory is a global-host affordance.
    expect(host.querySelector('.row-action')).toBeNull();
  });

  it('draws the whole session area in one pane, and folds it as a whole', async () => {
    const { host, fixture } = await render('global');

    // New session, the search and every project sit in the one pane's body, so
    // folding the pane takes all of them away together.
    const pane = host.querySelector('morse-pane.sessions') as HTMLElement;
    expect(pane).not.toBeNull();
    expect(pane.querySelector('.head button.primary')?.textContent).toContain('New session');
    expect(pane.querySelector('input[aria-label="Search sessions"]')).not.toBeNull();
    expect(pane.querySelectorAll('.row.group').length).toBeGreaterThan(0);

    const fold = pane.querySelector('.pane-fold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fold.click();
    fixture.detectChanges();

    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(pane.querySelector('.head')).toBeNull();
    expect(pane.querySelector('input[aria-label="Search sessions"]')).toBeNull();
    expect(pane.querySelectorAll('.row')).toHaveLength(0);

    // …and the chevron brings it all back.
    fold.click();
    fixture.detectChanges();
    expect(pane.querySelector('.head button.primary')).not.toBeNull();
    expect(pane.querySelectorAll('.row').length).toBeGreaterThan(0);
  });

  it('lifts a running session into In progress, and only that one', async () => {
    const { host: global } = await render('global');
    // `s1` streams, so it moves to the top section under a spinning mark…
    expect(global.querySelector('.group-label')?.textContent).toContain('In progress');
    const live = [...global.querySelectorAll('.session.live')];
    expect(live).toHaveLength(1);
    expect(live[0]?.querySelector('.mark.running')).not.toBeNull();
    expect(live[0]?.querySelector('.title')?.textContent).toContain('Morse work');
    // …and does not repeat inside its project, while the idle-but-live `s2` stays.
    // The tree's session rows are the leaves; the group rows are the projects.
    const listed = [...global.querySelectorAll('.row:not(.group) .label')].map(
      (node) => node.textContent,
    );
    expect(listed).toEqual(['Other work']);

    const { host: workspace } = await render('workspace');
    expect(workspace.querySelectorAll('.session.live')).toHaveLength(1);
    expect(workspace.querySelectorAll('.session.live .mark.running')).toHaveLength(1);
  });

  it('names what a live session is doing in In progress', async () => {
    const { host } = await render('global');
    // A background run has no transcript in this frontend, so it stays generic.
    expect(host.querySelector('.session.live .subtitle')?.textContent).toBe('Working…');
  });

  it('does not flicker a session into In progress while its agent starts', async () => {
    const { host, transport, fixture } = await render('global');
    // Opening another session makes the host spawn its agent; that beat of
    // `agentStarting` is not work, so the row must not jump into In progress.
    transport.openSession('s2');
    fixture.detectChanges();
    expect([...host.querySelectorAll('.session.live .title')].map((node) => node.textContent)).toEqual([
      'Morse work',
    ]);
  });

  it('moves a session\'s actions into a right-click menu', async () => {
    const { host, transport, fixture } = await render('global');
    // The row is a single-purpose button again: no inline `✕` to mis-click.
    expect(host.querySelector('.session .close')).toBeNull();

    const row = host.querySelector('.session') as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 }));
    fixture.detectChanges();

    expect(host.querySelector('.context-menu')).not.toBeNull();
    expect(host.textContent).toContain('Delete session…');

    // This host has no native dialogs, so the menu asks in place…
    (host.querySelector('.context-menu-item.danger') as HTMLElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.context-menu-question')).not.toBeNull();
    expect(transport.sent.some((message) => message.type === 'session/delete')).toBe(false);

    // …and only the second click deletes.
    const items = [...host.querySelectorAll('.context-menu-item')];
    (items.at(-1) as HTMLElement).click();
    fixture.detectChanges();
    const deleted = transport.sent.filter((message) => message.type === 'session/delete');
    expect(deleted).toHaveLength(1);
    expect(host.querySelector('.context-menu')).toBeNull();
  });

  it('offers the editor tab only where the host has one', async () => {
    // The browser host has no editor surface, so the row must be absent rather
    // than a menu entry that does nothing.
    const { host: browser, fixture: browserFixture } = await render('global');
    (browser.querySelector('.session') as HTMLElement).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 }),
    );
    browserFixture.detectChanges();
    expect(browser.textContent).toContain('Close session');
    expect(browser.textContent).not.toContain('Open in editor tab');

    // VS Code advertises `sessionTabs`, so the row is there and asks the host to
    // open that session in an editor tab.
    const { host, transport, fixture } = await render('workspace', false, { sessionTabs: true });
    (host.querySelector('.session') as HTMLElement).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 60 }),
    );
    fixture.detectChanges();
    const row = [...host.querySelectorAll('.context-menu-item')].find(
      (item) => item.textContent?.trim() === 'Open in editor tab',
    ) as HTMLElement;
    row.click();
    fixture.detectChanges();

    const opened = transport.sent.filter(
      (message) => message.type === 'host/command' && message.payload.command === 'openSessionTab',
    );
    expect(opened).toHaveLength(1);
    expect((opened[0] as { payload: { args?: { sessionId?: string } } }).payload.args?.sessionId).toBe(
      's1',
    );
  });

  it('asks for a folder instead of guessing when the host can browse directories', async () => {
    const { host, transport, fixture } = await render('global', true);

    (host.querySelector('.head button.primary') as HTMLElement).click();
    fixture.detectChanges();

    // The modal owns the question; the nav must not silently create a session in
    // the last-used project.
    expect(TestBed.inject(ShellState).projectPickerOpen()).toBe(true);
    expect(transport.sent.some((message) => message.type === 'session/new')).toBe(false);
  });

  it('opens the About dialog from the colophon at the foot of the sidebar', async () => {
    const { host, fixture } = await render('workspace');
    const shell = TestBed.inject(ShellState);
    expect(shell.aboutOpen()).toBe(false);

    footButton(host, 'About').click();
    fixture.detectChanges();

    // One signal, one overlay: the dialog itself is mounted by `app.html`.
    expect(shell.aboutOpen()).toBe(true);
  });

  it('opens the keyboard help from the colophon, next to About', async () => {
    const { host, fixture } = await render('workspace');
    const shell = TestBed.inject(ShellState);

    footButton(host, 'Keyboard shortcuts').click();
    fixture.detectChanges();

    expect(shell.shortcutsOpen()).toBe(true);
    // `app.html` mounts the dialog on that flag, and mounting is what registers. This
    // fixture is the sidebar alone, so stand in for the mount.
    TestBed.inject(OverlayStack).open(() => undefined);
    expect(shell.modalOpen()).toBe(true);
  });

  it('tells the reader a newer release is out, and stays quiet when the host refuses', async () => {
    // A host that does not advertise `updateCheck` never causes a request at all,
    // so a locked-down deployment sees the footer exactly as it was.
    const quiet = vi.fn<VersionLoader>();
    const refused = await render('global', false, { loader: quiet });
    // Effects run with change detection, and a standalone fixture does not drive
    // the application on its own — `tick()` is what flushes them here.
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    refused.fixture.detectChanges();

    expect(refused.host.querySelector('.foot .notice')).toBeNull();
    expect(quiet).not.toHaveBeenCalled();

    const asked = vi.fn<VersionLoader>(async () => ({ version: '9.9.9' }));
    const { host, fixture } = await render('global', false, { updateCheck: true, loader: asked });
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(asked).toHaveBeenCalledTimes(1);
    const notice = host.querySelector('.foot .notice') as HTMLAnchorElement;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('Update available');
    expect(notice.textContent).toContain('v9.9.9');
    // A link, not a command: the hint says what the reader has to run.
    expect(notice.href).toBe('https://github.com/supanadit/morse/releases/tag/v9.9.9');
    expect(notice.target).toBe('_blank');
    expect(notice.title).toContain('npm install -g @supanadit/morse-web@9.9.9');
    // The version it is newer than is still on the row below it — read from the
    // identity, so a release bump does not break this test.
    expect(footButton(host, 'About').textContent).toContain(`v${FRONTEND_IDENTITY.version}`);
  });

  it('reviews the notice with ?newer, which asks no host and fetches nothing', async () => {
    const request = vi.fn<VersionLoader>();
    window.history.replaceState({}, '', '/?newer=9.9.9');
    try {
      const { host, fixture } = await render('global', false, { loader: request });
      TestBed.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();

      // The badge has to be reviewable before a release exists, and this path
      // needs no permission because it never reaches the registry.
      expect(host.querySelector('.foot .notice')?.textContent).toContain('v9.9.9');
      expect(request).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('creates a session from the keyboard, the way the button does', async () => {
    // A workspace host already knows the folder, so the key is the button.
    const { transport, fixture } = await render('workspace');
    press('n', { ctrl: true, alt: true });
    fixture.detectChanges();

    const created = transport.sent.filter((message) => message.type === 'session/new');
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual({ cwd: '/work/morse' });

    // A browser host has no current project: the key asks for a folder too.
    const global = await render('global', true);
    press('n', { ctrl: true, alt: true });
    global.fixture.detectChanges();

    expect(TestBed.inject(ShellState).projectPickerOpen()).toBe(true);
    expect(global.transport.sent.some((message) => message.type === 'session/new')).toBe(false);
  });

  it('filters projects from the keyboard, but not on a host with one project', async () => {
    const { fixture } = await render('global');
    const shell = TestBed.inject(ShellState);

    // The panel lives in the sidebar, which a narrow host keeps as a closed
    // drawer: the shortcut has to open it or the panel would be off canvas.
    expect(shell.navigationOpen()).toBe(false);
    press('p', { ctrl: true, alt: true });
    fixture.detectChanges();
    expect(shell.navigationOpen()).toBe(true);
    expect(shell.projectFilterOpen()).toBe(true);
    expect(shell.modalOpen()).toBe(true);

    // VS Code's scope has one project, so there is nothing to filter: the action
    // is unbound, which is what the help dialog reads as "not in this host".
    const workspace = await render('workspace');
    workspace.fixture.detectChanges();
    expect(TestBed.inject(ShortcutService).available().get('project.filter')).toBe(false);

    press('p', { ctrl: true, alt: true });
    workspace.fixture.detectChanges();
    expect(TestBed.inject(ShellState).projectFilterOpen()).toBe(false);
  });

  it('puts the caret in the session search with `/`, opening the drawer if needed', async () => {
    const { host, fixture } = await render('global');
    const search = host.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;
    show(search);

    press('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(document.activeElement).toBe(search);
    expect(TestBed.inject(ShellState).navigationOpen()).toBe(false);

    // A closed drawer is hidden, and a hidden field cannot take focus: the
    // shortcut opens it, then lands the caret.
    await render('global');
    press('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(TestBed.inject(ShellState).navigationOpen()).toBe(true);
  });

  it('unfolds the sidebar column before focusing the search', async () => {
    const { host, fixture } = await render('global');
    TestBed.inject(LayoutState).toggleVisible('left');
    const search = host.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;
    // The folded column hides the field with `visibility`, so it still has layout
    // and a real box — only the fold flag says it is hidden.
    show(search);

    press('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(TestBed.inject(LayoutState).leftCollapsed()).toBe(false);
    expect(document.activeElement).toBe(search);
  });

  it('leaves `/` to a text field the caret is already in', async () => {
    const { host } = await render('global');
    const search = host.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;

    // Typing the character must not be hijacked by the shell.
    search.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(TestBed.inject(ShellState).navigationOpen()).toBe(false);
  });

  it('filters to one project from the chip, and back to all of them', async () => {
    const { host, fixture } = await render('global');
    expect(host.querySelectorAll('.row.group')).toHaveLength(2);
    expect(host.querySelector('.scope')?.textContent).toContain('All projects');

    (host.querySelector('.scope') as HTMLElement).click();
    fixture.detectChanges();
    const rows = [...host.querySelectorAll('morse-project-filter .row')] as HTMLElement[];
    expect(rows.map((row) => row.querySelector('.name')?.textContent?.trim())).toEqual([
      'All projects',
      'morse',
      'other',
    ]);

    rows[2].click();
    fixture.detectChanges();

    // One project, its sessions, and the chip saying which one.
    expect(host.querySelector('.scope')?.textContent).toContain('other');
    expect(host.querySelectorAll('.row.group')).toHaveLength(1);
    expect(host.textContent).toContain('Other work');
    expect(host.textContent).not.toContain('Morse work');
    expect(host.querySelector('morse-project-filter')).toBeNull();

    // …and the way back.
    (host.querySelector('.scope') as HTMLElement).click();
    fixture.detectChanges();
    ([...host.querySelectorAll('morse-project-filter .row')][0] as HTMLElement).click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.row.group')).toHaveLength(2);
  });

  it('keeps the session box about session titles, then offers the project it matched', async () => {
    const { host, fixture } = await render('global');
    const search = host.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;

    // A path is not a session title: no project row is shown for it any more.
    search.value = 'work/';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelectorAll('.row.group')).toHaveLength(0);
    // The tree's own empty state names the query; the project jump below it is the way out.
    expect(host.textContent).toContain('No session matches');
    expect(host.querySelectorAll('.empty-action').length).toBeGreaterThan(0);

    // But each project it does match is one click from its full session list.
    const jumps = [...host.querySelectorAll('.empty-action')] as HTMLElement[];
    expect(jumps).toHaveLength(2);
    jumps[1].click();
    fixture.detectChanges();

    expect(host.querySelector('.scope')?.textContent).toContain('other');
    expect(host.textContent).toContain('Other work');
    // The jumped-to project shows all of its sessions, so the query is dropped.
    expect((host.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement).value).toBe('');
  });
});
