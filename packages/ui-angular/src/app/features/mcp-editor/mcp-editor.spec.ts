import { signal } from '@angular/core';
import type { McpServerStatus } from '@morse/protocol';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { McpState } from '../../state/mcp-state';
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
  edit?: McpServerStatus,
): {
  element: HTMLElement;
  fixture: ComponentFixture<McpEditor>;
  request: ReturnType<typeof vi.fn>;
} {
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
  // The panel sets the edit target just before it opens the editor; doing it
  // after the first detection is the same sequence.
  if (edit !== undefined) {
    TestBed.inject(McpState).beginEdit(edit);
    fixture.detectChanges();
  }
  return { element: fixture.nativeElement as HTMLElement, fixture, request: fake.requestHostCommand };
}

afterEach(() => TestBed.resetTestingModule());

/** Type into an input the way a reader does, so Angular's binding sees it. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

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

  const GITHUB: McpServerStatus = {
    name: 'github',
    scope: 'project',
    source: '/repo/.pi/mcp.json',
    enabled: true,
    transport: 'stdio: npx -y server-github',
    state: 'connecting',
    tools: [],
    config: {
      name: 'github',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      cwd: '/work/repo',
      env: { GITHUB_TOKEN: 'secret' },
    },
  };

  it('opens on an existing server with its entry prefilled and its name fixed', () => {
    const { element } = render(undefined, false, () => undefined, true, GITHUB);

    expect(element.querySelector('h2')?.textContent).toContain('Edit github');
    const name = element.querySelector('#mcp-editor-name') as HTMLInputElement;
    expect(name.value).toBe('github');
    // The name is the entry's key, so a rename is not an in-place edit.
    expect(name.readOnly).toBe(true);
    expect((element.querySelector('#mcp-editor-command') as HTMLInputElement).value).toBe('npx');
    expect((element.querySelector('#mcp-editor-args') as HTMLInputElement).value).toBe(
      '-y server-github',
    );
    expect((element.querySelector('#mcp-editor-cwd') as HTMLInputElement).value).toBe('/work/repo');
    const rows = [...element.querySelectorAll<HTMLInputElement>('.kv-row input')].map(
      (input) => input.value,
    );
    expect(rows).toEqual(['GITHUB_TOKEN', 'secret']);
    expect(
      [...element.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Save changes',
      ),
    ).toBe(true);
    // The entry keeps its own scope: a move would leave the original behind.
    const scopes = [...element.querySelectorAll<HTMLButtonElement>('.scope-bar button')];
    expect(scopes.every((button) => button.disabled)).toBe(true);
  });

  it('saves an edited server back under its own name and scope', async () => {
    const { element, fixture, request } = render(
      undefined,
      false,
      (command) => (command === 'mcpAdd' ? { ok: true, issues: [] } : undefined),
      true,
      GITHUB,
    );

    const save = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save changes',
    );
    save?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(request).toHaveBeenCalledWith(
      'mcpAdd',
      expect.objectContaining({
        name: 'github',
        scope: 'project',
        type: 'stdio',
        command: 'npx',
        cwd: '/work/repo',
        env: { GITHUB_TOKEN: 'secret' },
      }),
      expect.any(Number),
    );
    expect(element.querySelector('.result.ok')?.textContent).toContain('Saved to this project');
  });

  /** The `mcpAdd` payload of a save, for the field-level assertions below. */
  async function savedPayload(
    element: HTMLElement,
    fixture: ComponentFixture<McpEditor>,
    request: ReturnType<typeof vi.fn>,
  ): Promise<Record<string, unknown> | undefined> {
    const save = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save changes',
    );
    save?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const call = request.mock.calls.find(([command]) => command === 'mcpAdd');
    return call?.[1] as Record<string, unknown> | undefined;
  }

  it('keeps a disabled server disabled when it is edited', async () => {
    const disabled: McpServerStatus = { ...GITHUB, enabled: false };
    const { element, fixture, request } = render(
      undefined,
      false,
      (command) => (command === 'mcpAdd' ? { ok: true, issues: [] } : undefined),
      true,
      disabled,
    );

    // A save rewrites the entry, so the `enabled: false` pin must be included.
    expect(await savedPayload(element, fixture, request)).toMatchObject({ enabled: false });
  });

  it('does not write a project pin back into the entry it overrides', async () => {
    const pinned: McpServerStatus = {
      ...GITHUB,
      enabled: false,
      override: '/repo/.pi/mcp.json',
    };
    const { element, fixture, request } = render(
      undefined,
      false,
      (command) => (command === 'mcpAdd' ? { ok: true, issues: [] } : undefined),
      true,
      pinned,
    );

    // The pin belongs to the project file; editing the server must not copy it.
    const payload = await savedPayload(element, fixture, request);
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('enabled');
  });

  it('sends an untouched argv back verbatim, spaces and all', async () => {
    const spaced: McpServerStatus = {
      ...GITHUB,
      config: { ...GITHUB.config!, args: ['-y', 'a b'] },
    };
    const { element, fixture, request } = render(
      undefined,
      false,
      (command) => (command === 'mcpAdd' ? { ok: true, issues: [] } : undefined),
      true,
      spaced,
    );

    // The form shows `-y a b`; splitting it again would lose the argument.
    expect(await savedPayload(element, fixture, request)).toMatchObject({
      args: ['-y', 'a b'],
    });
  });

  it('edits HTTP headers as part of the entry', async () => {
    const { element, fixture, request } = render(
      { ...DRAFT, type: 'http', command: '', url: 'https://example.com/mcp' },
      false,
      (command) => (command === 'mcpAdd' ? { ok: true, issues: [] } : undefined),
    );

    const addHeader = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '+ Add header',
    );
    addHeader?.click();
    fixture.detectChanges();

    const inputs = [...element.querySelectorAll<HTMLInputElement>('.kv-row input')];
    expect(inputs).toHaveLength(2);
    type(inputs[0]!, 'Authorization');
    type(inputs[1]!, 'Bearer token');
    fixture.detectChanges();

    await addServer(element, fixture);
    expect(request).toHaveBeenCalledWith(
      'mcpAdd',
      expect.objectContaining({
        name: 'docs',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      }),
      expect.any(Number),
    );
  });

  it('refuses a value without a name instead of dropping it', async () => {
    const { element, fixture, request } = render(DRAFT, false, (command) =>
      command === 'mcpAdd' ? { ok: true, issues: [] } : undefined,
    );

    const addVariable = [...element.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '+ Add variable',
    );
    addVariable?.click();
    fixture.detectChanges();

    const inputs = [...element.querySelectorAll<HTMLInputElement>('.kv-row input')];
    type(inputs[1]!, 'orphan value');
    fixture.detectChanges();

    await addServer(element, fixture);
    expect(element.querySelector('.error')?.textContent).toMatch(/Name the variable/);
    expect(request).not.toHaveBeenCalledWith('mcpAdd', expect.anything(), expect.anything());
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
