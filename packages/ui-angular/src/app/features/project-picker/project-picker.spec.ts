import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage, type ProjectSummary } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ShellState } from '../../state/shell-state';
import { ProjectPicker } from './project-picker';
import { OverlayEscape } from '../../ui/overlay-escape';

/** A tiny filesystem the fake host answers `listDirectories` from. */
const TREE: Record<string, string[]> = {
  '/home/me': ['projects'],
  '/home/me/projects': ['alpha', 'beta'],
  '/home/me/projects/alpha': [],
  '/home/me/projects/beta': [],
};

class FolderHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];
  /** Whether the last folder may host a session (`ProjectPolicy`). */
  canOpen = true;
  /** Projects pi already knows; empty means the picker opens on the browser. */
  projects: ProjectSummary[] = [];

  connect(): void {
    this.emitStatus('open');
  }

  send(message: ClientToHostMessage): void {
    this.sent.push(message);
    if (message.type === 'client/ready') {
      this.emitMessage({
        type: 'host/ready',
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            hostKind: 'server',
            scope: 'global',
            editorContext: false,
            nativeDialogs: false,
            insertIntoEditor: false,
            revealFile: false,
            directoryPicker: true,
          },
          state: {
            workspace: { cwd: '/home/me', name: 'me' },
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
      if (this.projects.length > 0) {
        this.emitMessage({ type: 'project/list', payload: { projects: this.projects } });
      }
      return;
    }
    if (
      message.type === 'host/command' &&
      message.payload.command === 'listDirectories' &&
      message.payload.requestId
    ) {
      const requested = message.payload.args?.['path'];
      const path = typeof requested === 'string' ? requested : '/home/me';
      const parent = path === '/home/me' ? undefined : '/home/me';
      this.emitMessage({
        type: 'host/command/result',
        payload: {
          requestId: message.payload.requestId,
          ok: true,
          data: {
            path,
            parent,
            directories: (TREE[path] ?? []).map((name) => ({
              name,
              path: `${path === '/home/me' ? '/home/me' : path}/${name}`.replace('//', '/'),
            })),
            isGitRepo: path.endsWith('/alpha'),
            canOpen: this.canOpen,
            roots: [{ name: 'me', path: '/home/me' }],
          },
        },
      });
    }
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

async function render(projects: ProjectSummary[] = []): Promise<{
  host: HTMLElement;
  transport: FolderHostTransport;
  fixture: ComponentFixture<ProjectPicker>;
}> {
  TestBed.resetTestingModule();
  const transport = new FolderHostTransport();
  transport.projects = projects;
  await TestBed.configureTestingModule({
    imports: [ProjectPicker],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();

  // The dialog no longer listens for Escape itself: the shell owns that one
  // listener (`ui/overlay-escape.ts`), so a spec that presses Escape mounts it.
  TestBed.inject(OverlayEscape);
  const fixture = TestBed.createComponent(ProjectPicker);
  fixture.detectChanges();
  await settle(fixture);
  return { host: fixture.nativeElement as HTMLElement, transport, fixture };
}

/** Lets the constructor's `listDirectories` promise land, then re-renders. */
async function settle(fixture: ComponentFixture<ProjectPicker>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

function rowNamed(host: HTMLElement, name: string): HTMLElement {
  const rows = [...host.querySelectorAll<HTMLElement>('.listing .row')];
  const row = rows.find((candidate) => candidate.textContent?.trim().endsWith(name));
  if (!row) {
    throw new Error(`No folder row named ${name}`);
  }
  return row;
}

function projectRowNamed(host: HTMLElement, name: string): HTMLElement {
  const rows = [...host.querySelectorAll<HTMLElement>('.project-row')];
  const row = rows.find(
    (candidate) => candidate.querySelector('.project-name')?.textContent?.trim() === name,
  );
  if (!row) {
    throw new Error(`No project row named ${name}`);
  }
  return row;
}

/** Types a path into the folder field, as a user would. */
function typePath(host: HTMLElement, value: string): void {
  const input = host.querySelector('.path-row input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Types into the projects screen's search field, as a user would. */
function typeProjectQuery(host: HTMLElement, value: string): void {
  const input = host.querySelector('.search input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Presses a key in the projects search field, where the caret lives. */
function pressInSearch(host: HTMLElement, key: string): void {
  const input = host.querySelector('.search input') as HTMLInputElement;
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** The row currently highlighted as the Enter target. */
function activeProjectName(host: HTMLElement): string | undefined {
  return host.querySelector('.project-row.active .project-name')?.textContent?.trim();
}

function listRequests(transport: FolderHostTransport): number {
  return transport.sent.filter(
    (message) => message.type === 'host/command' && message.payload.command === 'listDirectories',
  ).length;
}

describe('ProjectPicker', () => {
  it('browses into subfolders and creates a session in the chosen one', async () => {
    const { host, transport, fixture } = await render();

    // It starts at the host's default folder, not at some hardcoded guess.
    expect(host.querySelector('.selected')?.textContent).toContain('/home/me');
    expect(rowNamed(host, 'projects')).toBeTruthy();

    rowNamed(host, 'projects').click();
    await settle(fixture);
    expect(host.querySelector('.selected')?.textContent).toContain('/home/me/projects');

    rowNamed(host, 'alpha').click();
    await settle(fixture);
    const chosen = '/home/me/projects/alpha';
    expect(host.querySelector('.selected')?.textContent).toContain(chosen);
    // A git worktree is called out — a strong "this is a project" hint.
    expect(host.querySelector('.selected')?.textContent).toContain('git');

    (host.querySelector('.modal-foot .primary') as HTMLElement).click();
    fixture.detectChanges();

    const created = transport.sent.filter((message) => message.type === 'session/new');
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toEqual({ cwd: chosen });
  });

  it('refuses a folder the policy does not allow', async () => {
    const { host, transport, fixture } = await render();
    transport.canOpen = false;

    rowNamed(host, 'projects').click();
    await settle(fixture);

    expect(host.textContent).toContain('not in MORSE_PROJECTS');
    expect((host.querySelector('.modal-foot .primary') as HTMLButtonElement).disabled).toBe(true);

    (host.querySelector('.modal-foot .primary') as HTMLButtonElement).click();
    expect(transport.sent.some((message) => message.type === 'session/new')).toBe(false);
  });

  it('cancels back to the shell', async () => {
    const { host } = await render();
    (host.querySelector('.modal-foot .secondary') as HTMLElement).click();
    expect(TestBed.inject(ShellState).projectPickerOpen()).toBe(false);
  });

  it('loads subfolders live while the path is typed', async () => {
    const { host, fixture } = await render();

    typePath(host, '/home/me/projects');
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 350));
    fixture.detectChanges();

    expect(rowNamed(host, 'alpha')).toBeTruthy();
    expect(rowNamed(host, 'beta')).toBeTruthy();
    expect(host.querySelector('.selected')?.textContent).toContain('/home/me/projects');
    // Live browsing leaves the caret alone: the field keeps exactly what was typed.
    expect((host.querySelector('.path-row input') as HTMLInputElement).value).toBe(
      '/home/me/projects',
    );
  });

  it('debounces a burst of keystrokes into a single request', async () => {
    const { host, fixture, transport } = await render();
    const before = listRequests(transport);

    typePath(host, '/home/me/pro');
    typePath(host, '/home/me/proj');
    typePath(host, '/home/me/projects');
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(listRequests(transport) - before).toBe(1);
  });

  it('lets a click win over a keystroke still waiting out the debounce', async () => {
    const { host, fixture } = await render();

    typePath(host, '/home/me/projects/alpha');
    // Navigate before the debounce fires: the typed folder must not overwrite it.
    rowNamed(host, 'projects').click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 350));
    fixture.detectChanges();

    expect(host.querySelector('.selected')?.textContent).toContain('/home/me/projects');
    expect(host.querySelector('.selected')?.textContent).not.toContain('alpha');
  });

  describe('existing projects', () => {
    const PROJECTS: ProjectSummary[] = [
      { path: '/home/me/projects/alpha', name: 'alpha', sessionCount: 3, lastUsedAt: 1 },
      { path: '/home/me/projects/beta', name: 'beta', sessionCount: 1, lastUsedAt: 2 },
    ];

    it('opens on the known projects and starts a session in the one picked', async () => {
      const { host, transport } = await render(PROJECTS);

      // The first question is "which project?" — not "which folder?".
      expect(host.querySelectorAll('.project-row')).toHaveLength(2);
      expect(host.querySelector('.path-row')).toBeNull();

      projectRowNamed(host, 'beta').click();

      const created = transport.sent.filter((message) => message.type === 'session/new');
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toEqual({ cwd: '/home/me/projects/beta' });
    });

    it('narrows the project list as the reader types', async () => {
      const { host, fixture } = await render(PROJECTS);
      const input = host.querySelector('.search input') as HTMLInputElement;

      input.value = 'beta';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();

      expect(host.querySelectorAll('.project-row')).toHaveLength(1);
      expect(host.querySelector('.project-row .project-name')?.textContent).toContain('beta');
    });

    it('starts a session in the first match when Enter is pressed in the search field', async () => {
      const { host, fixture, transport } = await render(PROJECTS);

      typeProjectQuery(host, 'beta');
      pressInSearch(host, 'Enter');
      fixture.detectChanges();

      const created = transport.sent.filter((message) => message.type === 'session/new');
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toEqual({ cwd: '/home/me/projects/beta' });
    });

    it('moves the highlight with the arrow keys and Enter picks the highlighted project', async () => {
      const { host, fixture, transport } = await render(PROJECTS);

      expect(activeProjectName(host)).toBe('alpha');

      pressInSearch(host, 'ArrowDown');
      fixture.detectChanges();
      expect(activeProjectName(host)).toBe('beta');

      pressInSearch(host, 'Enter');
      fixture.detectChanges();

      const created = transport.sent.filter((message) => message.type === 'session/new');
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toEqual({ cwd: '/home/me/projects/beta' });
    });

    it('resets the highlight to the first match when the query changes', async () => {
      const { host, fixture } = await render(PROJECTS);

      pressInSearch(host, 'ArrowDown');
      fixture.detectChanges();
      expect(activeProjectName(host)).toBe('beta');

      typeProjectQuery(host, 'alpha');
      fixture.detectChanges();
      expect(activeProjectName(host)).toBe('alpha');
    });

    it('starts the first known project when Enter is pressed with an empty search', async () => {
      const { host, fixture, transport } = await render(PROJECTS);

      pressInSearch(host, 'Enter');
      fixture.detectChanges();

      const created = transport.sent.filter((message) => message.type === 'session/new');
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toEqual({ cwd: '/home/me/projects/alpha' });
    });

    it('does nothing on Enter when no project matches the query', async () => {
      const { host, fixture, transport } = await render(PROJECTS);

      typeProjectQuery(host, 'nothing-here');
      pressInSearch(host, 'Enter');
      fixture.detectChanges();

      expect(host.querySelectorAll('.project-row')).toHaveLength(0);
      expect(transport.sent.some((message) => message.type === 'session/new')).toBe(false);
    });

    it('puts the caret in the search field as soon as the dialog opens', async () => {
      const { host } = await render(PROJECTS);
      // The command palette hands off here after Enter; the reader must be able
      // to keep typing the project name without clicking the field first.
      expect(document.activeElement).toBe(host.querySelector('.search input'));
    });

    it('returns the caret to the search field when Escape steps back from the browser', async () => {
      const { host, fixture } = await render(PROJECTS);

      (host.querySelector('.modal-foot .primary') as HTMLElement).click();
      fixture.detectChanges();
      await settle(fixture);
      expect(document.activeElement).toBe(host.querySelector('.path-row input'));

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(host.querySelectorAll('.project-row')).toHaveLength(2);
      expect(document.activeElement).toBe(host.querySelector('.search input'));
    });

    it('browses to a folder pi has not seen before', async () => {
      const { host, transport, fixture } = await render(PROJECTS);

      (host.querySelector('.modal-foot .primary') as HTMLElement).click();
      fixture.detectChanges();
      await settle(fixture);

      // It swapped to the folder browser, starting at the host's default.
      expect(host.querySelector('.path-row')).toBeTruthy();
      expect(host.querySelector('.selected')?.textContent).toContain('/home/me');

      rowNamed(host, 'projects').click();
      await settle(fixture);
      const chosen = '/home/me/projects';
      expect(host.querySelector('.selected')?.textContent).toContain(chosen);

      (host.querySelector('.modal-foot .primary') as HTMLElement).click();
      const created = transport.sent.filter((message) => message.type === 'session/new');
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toEqual({ cwd: chosen });
    });

    it('Escape steps back from the browser to the project list', async () => {
      const { host, fixture } = await render(PROJECTS);

      (host.querySelector('.modal-foot .primary') as HTMLElement).click();
      fixture.detectChanges();
      await settle(fixture);
      expect(host.querySelector('.path-row')).toBeTruthy();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();

      expect(host.querySelectorAll('.project-row')).toHaveLength(2);
    });

    it('opens on the browser when pi knows no projects', async () => {
      const { host } = await render();

      expect(host.querySelector('.path-row')).toBeTruthy();
      expect(host.querySelector('.project-row')).toBeNull();
      // With no projects to search, the folder path is the field to type into.
      expect(document.activeElement).toBe(host.querySelector('.path-row input'));
    });
  });
});
