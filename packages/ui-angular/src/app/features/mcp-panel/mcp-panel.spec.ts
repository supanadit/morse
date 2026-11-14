import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigIssue, McpServerStatus, McpStatus } from '@morse/protocol';
import { McpPanel } from './mcp-panel';
import { McpState } from '../../state/mcp-state';
import { MorseService } from '../../host/morse.service';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';

/**
 * OpenCode's status payload: configured state only — no tools, no exposure, and
 * a note saying so. The panel must render it without inventing pi-shaped
 * decorations (an exposure chip, a tool count) or reading as broken.
 */
const OPENCODE_STATUS: McpStatus = {
  servers: [
    {
      name: 'context7',
      scope: 'global',
      source: '/home/u/.config/opencode/opencode.json',
      enabled: true,
      transport: 'http: https://mcp.context7.com/mcp',
      state: 'disconnected',
      tools: [],
    },
    {
      name: 'tavily',
      scope: 'global',
      source: '/home/u/.config/opencode/opencode.json',
      enabled: false,
      transport: 'http: https://mcp.tavily.com/mcp',
      state: 'disabled',
      tools: [],
    },
  ],
  errors: [],
  trusted: true,
  note: 'OpenCode reports configured state only; a server connects when a session starts.',
};

function render(status: McpStatus | undefined): HTMLElement {
  const mcp = {
    cwd: signal(''),
    status: signal(status),
    isLoading: signal(false),
    canFix: signal(true),
    refresh: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [McpPanel],
    providers: [
      { provide: MorseService, useValue: {} },
      { provide: McpState, useValue: mcp },
      { provide: ShellState, useValue: { closeMcp: () => undefined } },
      { provide: WorkspaceTabs, useValue: { noSessionInFront: signal(true) } },
    ],
  });
  const fixture = TestBed.createComponent(McpPanel);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('McpPanel with an OpenCode status', () => {
  it('renders configured state without pi-shaped decorations', () => {
    const el = render(OPENCODE_STATUS);
    const text = el.textContent ?? '';
    // The enabled server shows the honest state, not a tool count.
    expect(text).toContain('context7');
    expect(text).toContain('disconnected');
    // The disabled one reads as off, not failed.
    expect(text).toContain('tavily');
    // No empty exposure chip: `undefined` must never render as text.
    expect(text).not.toContain('undefined');
    // The degraded mode is stated.
    expect(text).toMatch(/configured state only/);
    // New-session semantics are stated once.
    expect(text).toMatch(/new sessions/);
  });

  it('an absent status renders the empty hint instead of an error', () => {
    const el = render(undefined);
    expect(el.textContent ?? '').toMatch(/No MCP servers are configured/);
  });
});

/** One config-file complaint, as the host reports it for a JSONC config. */
const PARSE_ISSUE: ConfigIssue = {
  file: '/c/opencode.json',
  fileId: 'config',
  scope: 'global',
  code: 'normalize',
  message: 'uses comments',
  snippet: '"a": 1,',
  fixable: true,
};

/**
 * The panel rendered over the real store, so a click proves the whole path: the
 * panel's button, `McpState.fix`, the `configFix` payload, and the re-read that
 * follows. `capabilities.mcp` is off so the store's background probe never races
 * the assertions.
 */
function renderWithState(
  status: McpStatus,
  fixResult: unknown = { ok: true, issues: [] },
  capabilities: { configFix?: boolean; filePreview?: boolean } = {},
): {
  element: HTMLElement;
  fixture: ComponentFixture<McpPanel>;
  requestHostCommand: ReturnType<typeof vi.fn>;
  openMcp: ReturnType<typeof vi.fn>;
} {
  let fixed = false;
  const requestHostCommand = vi.fn((command: string) => {
    if (command === 'configFix') {
      fixed = true;
      return Promise.resolve(fixResult);
    }
    if (command === 'mcpSetEnabled' || command === 'mcpRemove') {
      return Promise.resolve({ ok: true, issues: [] });
    }
    // A successful fix rewrites the file, so the next read is issue-free.
    return Promise.resolve(fixed ? { ...status, issues: [] } : status);
  });
  const openMcp = vi.fn();
  const fake = {
    capabilities: signal({
      mcp: false,
      configFix: capabilities.configFix ?? true,
      filePreview: capabilities.filePreview ?? false,
    }),
    workspace: signal({ cwd: '/repo', name: 'repo' }),
    engine: signal('opencode'),
    requestHostCommand,
    onMcpChanged: () => () => undefined,
    hostCommand: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [McpPanel],
    providers: [
      { provide: MorseService, useValue: fake },
      { provide: ShellState, useValue: { closeMcp: () => undefined } },
      {
        provide: WorkspaceTabs,
        useValue: { noSessionInFront: signal(false), openMcp },
      },
    ],
  });
  const fixture = TestBed.createComponent(McpPanel);
  fixture.detectChanges();
  return {
    element: fixture.nativeElement as HTMLElement,
    fixture,
    requestHostCommand,
    openMcp,
  };
}

/** The store's read and the panel's render both settle in promise callbacks. */
async function settle(fixture: ComponentFixture<McpPanel>): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

function buttonNamed(element: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  );
}

describe('McpPanel config issues', () => {
  it('shows a parse issue with a snippet and fixes it', async () => {
    const { element, fixture, requestHostCommand } = renderWithState({
      servers: [],
      errors: [],
      trusted: true,
      issues: [PARSE_ISSUE],
    });
    await settle(fixture);

    const text = element.textContent ?? '';
    expect(text).toContain('uses comments');
    expect(text).toContain('/c/opencode.json');
    expect(element.querySelector('pre.snippet')?.textContent).toContain('"a": 1,');

    const fix = buttonNamed(element, 'Fix');
    expect(fix).toBeDefined();
    fix?.click();
    await settle(fixture);

    expect(requestHostCommand).toHaveBeenCalledWith(
      'configFix',
      {
        engine: 'opencode',
        fileId: 'config',
        path: '/c/opencode.json',
        scope: 'global',
        cwd: '/repo',
      },
      expect.any(Number),
    );
    // The state re-reads after an ok, so the panel is no longer complaining.
    const reads = requestHostCommand.mock.calls.filter(([command]) => command === 'mcpStatus');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(element.textContent ?? '').not.toContain('uses comments');
    expect(element.querySelector('pre.snippet')).toBeNull();
  });

  it('disables the Fix buttons and shows “Fixing…” while a fix runs', async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const { element, fixture } = renderWithState(
      {
        servers: [],
        errors: [],
        issues: [
          PARSE_ISSUE,
          { ...PARSE_ISSUE, file: '/c/mcp.json', message: 'needs a rewrite too' },
        ],
      },
      pending,
    );
    await settle(fixture);

    (element.querySelector('.fix') as HTMLButtonElement).click();
    fixture.detectChanges();

    // One rewrite in flight holds every button, so a second cannot race it.
    const buttons = [...element.querySelectorAll('.fix')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]?.textContent).toContain('Fixing…');
    expect(buttons[0]?.getAttribute('aria-busy')).toBe('true');
    expect(buttons[1]?.textContent?.trim()).toBe('Fix');
    expect(buttons[1]?.getAttribute('aria-busy')).toBeNull();

    release?.({ ok: true, issues: [] });
    await settle(fixture);
    expect(element.querySelector('.fix')).toBeNull();
  });

  it('renders the pointer when the issue names one', async () => {
    const { element, fixture } = renderWithState({
      servers: [],
      errors: [],
      issues: [{ ...PARSE_ISSUE, pointer: '/mcpServers/docs/args' }],
    });
    await settle(fixture);

    expect(element.querySelector('.issue-pointer')?.textContent).toContain(
      '/mcpServers/docs/args',
    );
  });

  it('keeps two complaints about one file distinct when neither names a pointer', async () => {
    const { element, fixture } = renderWithState({
      servers: [],
      errors: [],
      issues: [
        { ...PARSE_ISSUE, message: 'uses comments' },
        { ...PARSE_ISSUE, message: 'has a trailing comma' },
      ],
    });
    await settle(fixture);

    const text = element.textContent ?? '';
    expect(text).toContain('uses comments');
    expect(text).toContain('has a trailing comma');
    expect(element.querySelectorAll('.fix')).toHaveLength(2);
  });

  it('drops the path line when the message already names the file', async () => {
    const { element, fixture } = renderWithState({
      servers: [],
      errors: [],
      issues: [
        {
          ...PARSE_ISSUE,
          message: '/c/opencode.json: rewrite this file without comments.',
        },
      ],
    });
    await settle(fixture);

    expect(element.textContent ?? '').toContain('rewrite this file without comments');
    expect(element.querySelector('.issue-file')).toBeNull();
    // The path appears once, inside the message, not again as its own line.
    expect((element.textContent ?? '').split('/c/opencode.json')).toHaveLength(2);
  });

  it('drops the path line for an unfixable issue whose message already names the file', async () => {
    const { element, fixture } = renderWithState({
      servers: [],
      errors: [],
      issues: [
        {
          ...PARSE_ISSUE,
          message: '/c/opencode.json: the file is not valid JSON.',
          fixable: false,
        },
      ],
    });
    await settle(fixture);

    expect(element.querySelector('.issue-file')).toBeNull();
    expect((element.textContent ?? '').split('/c/opencode.json')).toHaveLength(2);
    expect(element.textContent ?? '').toMatch(/hand edit/i);
  });

  it('shows an unfixable issue without a Fix button, and says it needs a hand edit', async () => {
    const { element, fixture } = renderWithState({
      servers: [],
      errors: [],
      issues: [
        {
          ...PARSE_ISSUE,
          code: 'parse',
          message: 'the file is not valid JSON',
          fixable: false,
        },
      ],
    });
    await settle(fixture);

    const text = element.textContent ?? '';
    expect(text).toContain('the file is not valid JSON');
    // The message does not name the file, so the row supplies the path.
    expect(element.querySelector('.issue-file')?.textContent).toContain(
      '/c/opencode.json',
    );
    expect(buttonNamed(element, 'Fix')).toBeUndefined();
    expect(text).toMatch(/hand edit/i);
  });

  it('hides Fix and asks for a hand edit when the host cannot fix', async () => {
    const { element, fixture } = renderWithState(
      { servers: [], errors: [], issues: [PARSE_ISSUE] },
      { ok: true, issues: [] },
      { configFix: false },
    );
    await settle(fixture);

    expect(buttonNamed(element, 'Fix')).toBeUndefined();
    expect(element.textContent ?? '').toMatch(
      /Fix is not available in this host — edit the file by hand/,
    );
    // The complaint is still fully rendered: only the action is gone.
    expect(element.textContent ?? '').toContain('uses comments');
  });

  it('shows the host’s refusal when a fix fails', async () => {
    const { element, fixture } = renderWithState(
      { servers: [], errors: [], issues: [PARSE_ISSUE] },
      { ok: false, message: 'The host refused to rewrite the file.' },
    );
    await settle(fixture);

    buttonNamed(element, 'Fix')?.click();
    await settle(fixture);

    expect(buttonNamed(element, 'Fix')).toBeDefined();
    // The refusal is announced, not just painted.
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      'The host refused to rewrite the file.',
    );
    expect(element.querySelector('.fix')?.getAttribute('aria-label')).toBe(
      'Fix /c/opencode.json',
    );
  });

  it('keeps the legacy errors text when there are no structured issues', async () => {
    const { element, fixture } = renderWithState({
      servers: [],
      errors: ['mcp.json could not be read.'],
      trusted: true,
    });
    await settle(fixture);

    expect(element.textContent ?? '').toContain('mcp.json could not be read.');
    expect(element.querySelector('pre.snippet')).toBeNull();
  });
});

/**
 * The row's controls: on/off is a switch that mirrors the server's real state,
 * and removal is an icon that still asks before it deletes anything.
 */
describe('McpPanel row controls', () => {
  /** The panel defaults to project scope; a global row's tests switch first. */
  function useGlobalScope(element: HTMLElement): void {
    buttonNamed(element, 'Global')?.click();
  }

  function switches(element: HTMLElement): HTMLButtonElement[] {
    return [...element.querySelectorAll('[role="switch"]')] as HTMLButtonElement[];
  }

  it('renders a switch per server that mirrors its enabled state', async () => {
    const { element, fixture } = renderWithState(OPENCODE_STATUS);
    await settle(fixture);

    const toggles = switches(element);
    expect(toggles.map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    // Project scope on a user-level row says what the flip writes: an override.
    expect(toggles[0]?.getAttribute('aria-label')).toBe('Disable context7 for this project');
    expect(toggles[1]?.getAttribute('aria-label')).toBe('Enable tavily for this project');
    // The action is no longer a text button beside the row.
    expect(
      [...element.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Disable here',
      ),
    ).toBe(false);
  });

  it('flips the switch’s own server: on turns it off, off turns it on', async () => {
    const { element, fixture, requestHostCommand } = renderWithState(OPENCODE_STATUS);
    await settle(fixture);
    useGlobalScope(element);
    fixture.detectChanges();

    const [first, second] = switches(element);
    expect(first?.getAttribute('aria-label')).toBe('Disable context7');

    first?.click();
    await settle(fixture);
    expect(requestHostCommand).toHaveBeenCalledWith(
      'mcpSetEnabled',
      { name: 'context7', enabled: false, scope: 'global', cwd: '/repo', engine: 'opencode' },
      expect.any(Number),
    );

    second?.click();
    await settle(fixture);
    expect(requestHostCommand).toHaveBeenCalledWith(
      'mcpSetEnabled',
      { name: 'tavily', enabled: true, scope: 'global', cwd: '/repo', engine: 'opencode' },
      expect.any(Number),
    );
  });

  it('removes a server through the trash button, after a confirmation', async () => {
    const { element, fixture, requestHostCommand } = renderWithState(OPENCODE_STATUS);
    await settle(fixture);
    useGlobalScope(element);
    fixture.detectChanges();

    const trash = element.querySelector<HTMLButtonElement>('button[aria-label="Remove context7"]');
    expect(trash).not.toBeNull();
    // Icon only: its accessible name carries the action.
    expect(trash?.textContent?.trim()).toBe('');

    trash?.click();
    fixture.detectChanges();
    expect(requestHostCommand).not.toHaveBeenCalledWith(
      'mcpRemove',
      expect.anything(),
      expect.anything(),
    );
    expect(buttonNamed(element, 'Remove?')).toBeDefined();

    buttonNamed(element, 'Remove?')?.click();
    await settle(fixture);
    expect(requestHostCommand).toHaveBeenCalledWith(
      'mcpRemove',
      { name: 'context7', scope: 'global', cwd: '/repo', engine: 'opencode' },
      expect.any(Number),
    );
  });

  it('edits an existing server through the pencil, prefilling the editor', async () => {
    const server: McpServerStatus = {
      name: 'github',
      scope: 'global',
      source: '/home/u/.pi/agent/mcp.json',
      enabled: true,
      transport: 'stdio: npx -y server-github',
      state: 'connecting',
      tools: [],
      config: {
        name: 'github',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server-github'],
        env: { GITHUB_TOKEN: 'secret' },
      },
    };
    const { element, fixture, openMcp } = renderWithState(
      { servers: [server], errors: [], trusted: true },
      { ok: true, issues: [] },
      { filePreview: true },
    );
    await settle(fixture);

    const edit = element.querySelector<HTMLButtonElement>('button[aria-label="Edit github"]');
    expect(edit).not.toBeNull();
    edit?.click();
    fixture.detectChanges();

    // The row is handed to the shared editor state, then the editor tab opens.
    expect(TestBed.inject(McpState).editing()?.name).toBe('github');
    expect(openMcp).toHaveBeenCalled();
  });

  it('offers no pencil on a host whose editor is a separate panel', async () => {
    const server: McpServerStatus = {
      name: 'github',
      scope: 'global',
      source: '/home/u/.pi/agent/mcp.json',
      enabled: true,
      transport: 'stdio: npx -y server-github',
      state: 'connecting',
      tools: [],
      config: { name: 'github', type: 'stdio', command: 'npx' },
    };
    // No tab strip: the editor is its own webview with its own state.
    const { element, fixture } = renderWithState({ servers: [server], errors: [], trusted: true });
    await settle(fixture);

    expect(element.querySelector('button[aria-label="Edit github"]')).toBeNull();
  });

  it('offers no pencil when the host does not send the entry', async () => {
    // OPENCODE_STATUS rows carry no `config`: an older host cannot prefill a form.
    const { element, fixture } = renderWithState(OPENCODE_STATUS);
    await settle(fixture);

    expect(element.querySelector('button[aria-label="Edit context7"]')).toBeNull();
  });

  it('disables the switch for a server the chosen scope cannot edit', async () => {
    const { element, fixture } = renderWithState({
      servers: [
        {
          name: 'from-extension',
          scope: 'extension',
          source: 'extension',
          enabled: true,
          transport: 'stdio: extension',
          state: 'connected',
          tools: [],
        },
      ],
      errors: [],
      trusted: true,
    });
    await settle(fixture);

    const toggle = switches(element)[0];
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.getAttribute('title')).toMatch(/extension/i);
  });
});
