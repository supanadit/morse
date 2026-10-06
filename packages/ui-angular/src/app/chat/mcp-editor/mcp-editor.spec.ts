import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../core/morse.service';
import { MORSE_TRANSPORT } from '../../core/transport.token';
import { McpEditor } from './mcp-editor';

/**
 * A reload must not eat the half-filled MCP entry. The editor hydrates from the
 * host's store (`ViewState`) on construction — the browser host's
 * `localStorage`, or VS Code's webview state that its panel serializer restores.
 */
function render(saved?: unknown): HTMLElement {
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
    }),
    workspace: signal({ cwd: '/repo', name: 'repo' }),
    requestHostCommand: vi.fn(() => Promise.resolve(undefined)),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [McpEditor],
    providers: [
      { provide: MORSE_TRANSPORT, useValue: transport },
      { provide: MorseService, useValue: fake },
    ],
  });
  if (saved !== undefined) {
    transport.writeState({ 'morse.view.mcp-editor': saved });
  }
  const fixture = TestBed.createComponent(McpEditor);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

afterEach(() => TestBed.resetTestingModule());

describe('McpEditor', () => {
  it('restores a saved draft after a reload', () => {
    const element = render({
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
    const element = render();
    const name = element.querySelector('#mcp-editor-name') as HTMLInputElement | null;
    expect(name?.value).toBe('');
  });
});
