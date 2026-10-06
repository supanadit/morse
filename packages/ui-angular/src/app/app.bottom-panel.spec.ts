import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { PanelState } from './core/panel-state';
import { ShellState } from './core/shell-state';
import { MORSE_TRANSPORT } from './core/transport.token';

/** A browser host with the terminal on, so the bottom panel is mounted. */
class TerminalHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  /**
   * `sessionId: null` is the empty-session view: a browser host with no session
   * in front. `gitPanel` turns on the right column so a test can assert it too.
   */
  constructor(
    private readonly sessionId: string | null = 'session-1',
    private readonly gitPanel = false,
  ) {
    super();
  }

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
          ...(this.gitPanel ? { gitPanel: true } : {}),
        },
        state: {
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
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

  /**
   * The empty-session view is only the sidebar: no session means no project, so
   * the Explorer, the git column and the terminal must not show whatever the
   * last session or closed tab left behind.
   */
  it('hides every project surface while no session is in front', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: MORSE_TRANSPORT, useFactory: () => new TerminalHostTransport(null, true) },
      ],
    });
    const fixture = TestBed.createComponent(App);
    TestBed.inject(ShellState).toggleGitPanel();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // The empty state is the panel; nothing project-scoped is beside it.
    expect(host.querySelector('morse-empty-session')).not.toBeNull();
    expect(host.querySelector('morse-file-explorer')).toBeNull();
    expect(host.querySelector('morse-git-panel')).toBeNull();
    expect(host.querySelector('morse-bottom-panel')).toBeNull();
  });

  it('keeps the project surfaces when a session is in front', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: MORSE_TRANSPORT, useFactory: () => new TerminalHostTransport('session-2', true) },
      ],
    });
    const fixture = TestBed.createComponent(App);
    TestBed.inject(ShellState).toggleGitPanel();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('morse-empty-session')).toBeNull();
    expect(host.querySelector('morse-file-explorer')).not.toBeNull();
    expect(host.querySelector('morse-git-panel')).not.toBeNull();
    expect(host.querySelector('morse-bottom-panel')).not.toBeNull();
  });
});
