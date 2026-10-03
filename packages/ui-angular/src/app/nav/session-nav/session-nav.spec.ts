import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { vi } from 'vitest';
import { FRONTEND_IDENTITY } from '../../core/morse.service';
import { MORSE_TRANSPORT } from '../../core/transport.token';
import { ShellState } from '../../core/shell-state';
import { ShortcutService } from '../../core/shortcuts';
import { UPDATE_LOADER, type VersionLoader } from '../../core/update';
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
        sessions: scoped
          ? [{ id: 's1', title: 'Morse work', cwd: '/work/morse', updatedAt: 2, messageCount: 3 }]
          : [
              { id: 's1', title: 'Morse work', cwd: '/work/morse', updatedAt: 2, messageCount: 3 },
              { id: 's2', title: 'Other work', cwd: '/work/other', updatedAt: 1, messageCount: 5 },
            ],
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

  dispose(): void {
    this.emitStatus('closed');
  }
}

/** What a test needs beyond the scope: whether the host allows the release check. */
interface RenderOptions {
  updateCheck?: boolean;
  loader?: VersionLoader;
}

async function render(
  scope: 'global' | 'workspace',
  directoryPicker = false,
  options: RenderOptions = {},
): Promise<{ host: HTMLElement; transport: ScopedHostTransport; fixture: ComponentFixture<SessionNav> }> {
  TestBed.resetTestingModule();
  const transport = new ScopedHostTransport(scope, directoryPicker, options.updateCheck === true);
  await TestBed.configureTestingModule({
    imports: [SessionNav],
    providers: [
      { provide: MORSE_TRANSPORT, useFactory: () => transport },
      // Never the real loader: a test must not be able to reach the registry.
      { provide: UPDATE_LOADER, useValue: options.loader },
    ],
  }).compileComponents();

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
  it('groups sessions by project for a global host', async () => {
    const { host } = await render('global');
    const text = host.textContent ?? '';

    expect(host.querySelectorAll('.group-title')).toHaveLength(2);
    expect(text).toContain('morse');
    expect(text).toContain('other');
    expect(text).toContain('Morse work');
    expect(text).toContain('Other work');
    // The per-project action lives in the project header as a "+" icon.
    expect(host.querySelectorAll('.group-new')).toHaveLength(2);
    expect(host.querySelector('.group-new')?.getAttribute('aria-label')).toContain('morse');
  });

  it('shows one group and no project switcher for a workspace-scoped host', async () => {
    const { host } = await render('workspace');
    const text = host.textContent ?? '';

    // One project means the group header (and its accordion) is noise.
    expect(host.querySelector('.group-title')).toBeNull();
    expect(text).toContain('Morse work');
    expect(text).not.toContain('Other work');
    // Creating a session in *another* directory is a global-host affordance.
    expect(host.querySelector('.group-new')).toBeNull();
  });

  it('pulses only the sessions the agent is actually running in', async () => {
    const { host: global } = await render('global');
    // `s1` streams, so it pulses; the idle-but-live `s2` stays still.
    expect(global.querySelectorAll('.session.running')).toHaveLength(1);
    expect(global.querySelectorAll('.session .pulse')).toHaveLength(1);
    expect(global.querySelector('.session.running .title')?.textContent).toContain('Morse work');

    const { host: workspace } = await render('workspace');
    // VS Code's scope filters the list, so only the running `s1` survives.
    expect(workspace.querySelectorAll('.session.running')).toHaveLength(1);
    expect(workspace.querySelectorAll('.session .pulse')).toHaveLength(1);
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
    const shell = TestBed.inject(ShellState);
    shell.toggleNavigationCollapsed();
    const search = host.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;
    // The folded column hides the field with `visibility`, so it still has layout
    // and a real box — only the fold flag says it is hidden.
    show(search);

    press('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(shell.navigationCollapsed()).toBe(false);
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
    expect(host.querySelectorAll('.group-title')).toHaveLength(2);
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
    expect(host.querySelectorAll('.group-title')).toHaveLength(1);
    expect(host.textContent).toContain('Other work');
    expect(host.textContent).not.toContain('Morse work');
    expect(host.querySelector('morse-project-filter')).toBeNull();

    // …and the way back.
    (host.querySelector('.scope') as HTMLElement).click();
    fixture.detectChanges();
    ([...host.querySelectorAll('morse-project-filter .row')][0] as HTMLElement).click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.group-title')).toHaveLength(2);
  });

  it('keeps the session box about session titles, then offers the project it matched', async () => {
    const { host, fixture } = await render('global');
    const search = host.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;

    // A path is not a session title: no group is shown for it any more.
    search.value = 'work/';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelectorAll('.group-title')).toHaveLength(0);
    expect(host.textContent).toContain('Looking for a project?');

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
