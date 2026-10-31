import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { McpStatus } from '@morse/protocol';
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
