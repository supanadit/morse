import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { MORSE_TRANSPORT } from './core/transport.token';
import { ShellState } from './core/shell-state';

/**
 * A host that shows a session as its own editor tab (VS Code) hands the app
 * `embedded`. This locks the one thing that surface must never do: render the
 * Morse sidebar (the window already has one) or let the shared fold preference
 * collapse its only column.
 */
class EmbeddedTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  connect(): void {
    this.emitStatus('open');
  }

  dispose(): void {
    this.emitStatus('closed');
  }

  send(message: ClientToHostMessage): void {
    if (message.type !== 'client/ready') {
      return;
    }
    this.emitMessage({
      type: 'host/ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          hostKind: 'vscode',
          scope: 'workspace',
          editorContext: true,
          nativeDialogs: true,
          insertIntoEditor: true,
          revealFile: true,
          sessionTabs: true,
        },
        state: {
          sessionId: 'session-1',
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
  }
}

function render(): ComponentFixture<App> {
  const fixture = TestBed.createComponent(App);
  // The route surface passes this; a session tab is never standalone.
  fixture.componentRef.setInput('embedded', true);
  fixture.detectChanges();
  return fixture;
}

describe('App embedded (a session editor tab)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('does not render the Morse sidebar the window already has', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new EmbeddedTransport() }],
    });
    const fixture = render();
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('morse-session-nav')).toBeNull();
    // The conversation itself is still there.
    expect(host.querySelector('morse-chat-header')).toBeTruthy();
  });

  it('hides the sidebar toggles that would act on a sidebar it does not have', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new EmbeddedTransport() }],
    });
    const fixture = render();
    const header: HTMLElement = fixture.nativeElement.querySelector('morse-chat-header');

    expect(header.querySelector('.menu')).toBeNull();
    expect(header.querySelector('.collapse')).toBeNull();
  });

  it('keeps its one column even when the shared fold preference says collapsed', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new EmbeddedTransport() }],
    });
    // The fold lives in the shell state and is persisted, so a reader who folded
    // the sidebar in the panel once must not collapse this surface's only column
    // to zero — which is a blank tab, not a folded sidebar.
    TestBed.inject(ShellState).toggleNavigationCollapsed();
    const fixture = render();
    const shell: HTMLElement = fixture.nativeElement.querySelector('.shell');

    expect(shell.classList.contains('embedded')).toBe(true);
    expect(shell.classList.contains('collapsed')).toBe(true);
    // Specificity is the whole test: `.shell.embedded.collapsed` must outrank
    // the `.shell.collapsed` rule inside the wide-layout media query.
    const embeddedRules = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .map((rule) => rule.cssText)
      .filter((text) => text.includes('.shell.embedded.collapsed'));
    expect(embeddedRules.length).toBeGreaterThan(0);
  });
});
