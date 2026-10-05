import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { PanelState } from './core/panel-state';
import { MORSE_TRANSPORT } from './core/transport.token';

/** A browser host with the terminal on, so the bottom panel is mounted. */
class TerminalHostTransport extends BaseHostTransport {
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
          hostKind: 'server',
          scope: 'global',
          editorContext: false,
          nativeDialogs: false,
          insertIntoEditor: false,
          revealFile: false,
          filePreview: true,
          terminal: true,
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

describe('App bottom panel', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  /**
   * Full screen is the bottom panel's answer to the git panel's full mode: the
   * terminal takes the whole conversation column, and the chat steps aside.
   */
  it('gives the bottom panel the whole conversation column in full screen', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TerminalHostTransport() }],
    });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const chat = host.querySelector('main.chat') as HTMLElement;
    expect(chat.classList.contains('bottom-full')).toBe(false);

    // The panel's own button is the only way in; drive it like a reader would.
    const full = host.querySelector(
      'morse-bottom-panel .toggle[aria-label="Full screen"]',
    ) as HTMLButtonElement;
    full.click();
    fixture.detectChanges();

    expect(TestBed.inject(PanelState).full()).toBe(true);
    expect(chat.classList.contains('bottom-full')).toBe(true);
    expect(host.querySelector('morse-bottom-panel')?.classList.contains('full')).toBe(true);
  });
});
