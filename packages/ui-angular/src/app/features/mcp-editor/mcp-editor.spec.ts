import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { McpEditor } from './mcp-editor';

/**
 * A reload must not eat the half-filled MCP entry. The editor hydrates from the
 * host's store (`ViewState`) on construction — the browser host's
 * `localStorage`, or VS Code's webview state that its panel serializer restores.
 */
function render(
  saved?: unknown,
  noSession = false,
  respond: (command: string) => unknown = () => undefined,
  configFix = true,
): { element: HTMLElement; fixture: ComponentFixture<McpEditor> } {
  const transport = new MemoryHostTransport();
  const fake = {
    capabilities: signal({
      hostKind: 'server',
      scope: 'global',
      editorContext: false,
      nativeDialogs: false,
      insertIntoEditor: false,
      revealFile: false,
      mcp: true,
      configFix,
    }),
    workspace: signal({ cwd: '/repo', name: 'repo' }),
    engine: signal<string | undefined>(undefined),
    requestHostCommand: vi.fn((command: string) => Promise.resolve(respond(command))),
    onMcpChanged: () => () => undefined,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [McpEditor],
    providers: [
      { provide: MORSE_TRANSPORT, useValue: transport },
      { provide: MorseService, useValue: fake },
      { provide: WorkspaceTabs, useValue: { noSessionInFront: signal(noSession) } },
    ],
  });
  if (saved !== undefined) {
    transport.writeState({ 'morse.view.mcp-editor': saved });
  }
  const fixture = TestBed.createComponent(McpEditor);
  fixture.detectChanges();
  return { element: fixture.nativeElement as HTMLElement, fixture };
}

afterEach(() => TestBed.resetTestingModule());

describe('McpEditor', () => {
  it('restores a saved draft after a reload', () => {
    const { element } = render({
      name: 'asdadad',
      type: 'stdio',
      command: 'asda',
      argsText: 'asdasd',
      url: '',
      exposure: 'codemode',
      scope: 'project',
    });

    const value = (selector: string) =>
      (element.querySelector(selector) as HTMLInputElement | null)?.value;
    expect(value('#mcp-editor-name')).toBe('asdadad');
    expect(value('#mcp-editor-command')).toBe('asda');
    expect(value('#mcp-editor-args')).toBe('asdasd');
  });

  it('starts empty without a saved draft', () => {
    const { element } = render();
    const name = element.querySelector('#mcp-editor-name') as HTMLInputElement | null;
    expect(name?.value).toBe('');
  });

  it('is global-only with no session: the project scope is disabled', () => {
    const { element } = render(undefined, true);
    const project = element.querySelector(
      '.scope-bar button:first-of-type',
    ) as HTMLButtonElement | null;
    const global = element.querySelector(
      '.scope-bar button:last-of-type',
    ) as HTMLButtonElement | null;

    // A project entry has nowhere to be written, so the choice stands down.
    expect(project?.disabled).toBe(true);
    expect(global?.classList.contains('active')).toBe(true);
  });

  const DRAFT = {
    name: 'docs',
    type: 'stdio',
    command: 'node',
    argsText: '',
    url: '',
    exposure: 'codemode',
    scope: 'project',
  };

  /** A save refused because the config file is JSONC, not strict JSON. */
  const NORMALIZE_REFUSAL = {
    ok: false,
    issues: [
      {
        file: '/repo/.opencode/opencode.json',
        fileId: 'config',
        scope: 'project',
        code: 'normalize',
        message: 'rewrite this file without comments',
        fixable: true,
      },
    ],
  };

  async function addServer(
    element: HTMLElement,
    fixture: ComponentFixture<McpEditor>,
  ): Promise<void> {
    const add = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Add server',
    );
    add?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('names the Fix action when a save fails on a file that needs normalizing', async () => {
    const { element, fixture } = render(DRAFT, false, (command) =>
      command === 'mcpAdd' ? NORMALIZE_REFUSAL : undefined,
    );
    await addServer(element, fixture);

    expect(element.querySelector('.error')?.textContent).toMatch(
      /press Fix on it in the MCP manager/,
    );
  });

  it('asks for a hand edit instead when the host does not offer Fix', async () => {
    const { element, fixture } = render(
      DRAFT,
      false,
      (command) => (command === 'mcpAdd' ? NORMALIZE_REFUSAL : undefined),
      false,
    );
    await addServer(element, fixture);

    expect(element.querySelector('.error')?.textContent).toMatch(/edited by hand/);
    expect(element.querySelector('.error')?.textContent).not.toMatch(/press Fix/);
  });
});
