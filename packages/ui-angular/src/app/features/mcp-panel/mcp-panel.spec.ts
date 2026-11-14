import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigIssue, McpStatus } from '@morse/protocol';
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
): {
  element: HTMLElement;
  fixture: ComponentFixture<McpPanel>;
  requestHostCommand: ReturnType<typeof vi.fn>;
} {
  let fixed = false;
  const requestHostCommand = vi.fn((command: string) => {
    if (command === 'configFix') {
      fixed = true;
      return Promise.resolve(fixResult);
    }
    // A successful fix rewrites the file, so the next read is issue-free.
    return Promise.resolve(fixed ? { ...status, issues: [] } : status);
  });
  const fake = {
    capabilities: signal({ mcp: false }),
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
      { provide: WorkspaceTabs, useValue: { noSessionInFront: signal(false) } },
    ],
  });
  const fixture = TestBed.createComponent(McpPanel);
  fixture.detectChanges();
  return {
    element: fixture.nativeElement as HTMLElement,
    fixture,
    requestHostCommand,
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
    expect(buttonNamed(element, 'Fix')).toBeUndefined();
    expect(text).toMatch(/hand edit/i);
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
    expect(element.textContent ?? '').toContain('The host refused to rewrite the file.');
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
