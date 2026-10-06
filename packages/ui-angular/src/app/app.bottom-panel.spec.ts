import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The panel mounts real Terminal components once a shell is opened; jsdom has no
// canvas, so the emulator is mocked (see terminal.spec.ts), carrying the CJS
// `default` shape the lazy import unwraps.
vi.mock('@xterm/xterm', () => ({
  default: {
    Terminal: class {
      cols = 80;
      rows = 24;
      readonly parser = { registerOscHandler: () => ({ dispose: () => undefined }) };
      open(): void {}
      loadAddon(): void {}
      registerLinkProvider() {
        return { dispose: () => undefined };
      }
      onData() {
        return { dispose: () => undefined };
      }
      onResize() {
        return { dispose: () => undefined };
      }
      onTitleChange() {
        return { dispose: () => undefined };
      }
      write(): void {}
      reset(): void {}
      focus(): void {}
      dispose(): void {}
    },
  },
}));
vi.mock('@xterm/addon-fit', () => ({ default: { FitAddon: class { fit(): void {} } } }));
vi.mock('@xterm/addon-webgl', () => ({
  default: {
    WebglAddon: class {
      onContextLoss(): void {}
      dispose(): void {}
    },
  },
}));

import { App } from './app';
import { PanelState } from './core/panel-state';
import { ShellState } from './core/shell-state';
import { TerminalStore } from './core/terminal-store';
import { MORSE_TRANSPORT } from './core/transport.token';

/** A browser host with the terminal on, so the bottom panel is mounted. */
class TerminalHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  /** Every client message, so a test can prove a shell was not closed. */
  readonly sent: ClientToHostMessage[] = [];

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
    this.sent.push(message);
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
          mcp: true,
          ...(this.gitPanel ? { gitPanel: true } : {}),
        },
        state: {
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          workspace: { cwd: '/work/morse', name: 'morse' },
          model: { provider: 'ollama', id: 'deepseek', name: 'DeepSeek V4.1 Flash' },
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
   * last session or closed tab left behind. The terminal panel is hidden rather
   * than unmounted, because unmounting it would end its host-owned shells.
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
    // The terminal panel is still mounted — hidden, so its shells survive — not
    // gone, which would have closed them (see `bottomPanelEnabled`).
    const terminalPanel = host.querySelector('morse-bottom-panel');
    expect(terminalPanel).not.toBeNull();
    expect(terminalPanel?.classList.contains('host-hidden')).toBe(true);
    // The header drops the session's model and the project-scoped buttons too.
    expect(host.querySelector('.meta')?.textContent ?? '').not.toContain('DeepSeek');
    expect(host.querySelector('[aria-label="Show the git panel"]')).toBeNull();
    expect(host.querySelector('[aria-label="Hide the git panel"]')).toBeNull();
    // The tool-call density toggle is about a transcript, so it stands down…
    expect(host.querySelector('[aria-label^="Tool call display"]')).toBeNull();
    // …but MCP stays: with no session the panel edits the user's own servers.
    expect(host.querySelector('[aria-label="MCP servers"]')).not.toBeNull();
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
    const terminalPanel = host.querySelector('morse-bottom-panel');
    expect(terminalPanel).not.toBeNull();
    expect(terminalPanel?.classList.contains('host-hidden')).toBe(false);
    // With a session in front the model and the project buttons are back.
    expect(host.querySelector('.meta')?.textContent ?? '').toContain('DeepSeek V4.1 Flash');
    expect(host.querySelector('[aria-label="MCP servers"]')).not.toBeNull();
    expect(host.querySelector('[aria-label^="Tool call display"]')).not.toBeNull();
  });

  /**
   * A running shell belongs to the host, not to the panel's visibility: hiding
   * the panel on the empty view must not unmount the pane and close the shell.
   * Before the fix the panel was `@if`-gated on `noSessionInFront`, so this hid
   * it by destroying the terminal — and the command running in it.
   */
  it('keeps a terminal mounted, and its host shell alive, while the panel is hidden', async () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TerminalHostTransport(null) }],
    });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();

    // The terminal tool is the only view the panel has; open it, then run a shell
    // under the empty draft (owner `undefined`) the host is showing.
    TestBed.inject(PanelState).toggle('terminal');
    fixture.detectChanges();
    await fixture.whenStable();
    TestBed.inject(TerminalStore).open(undefined);
    fixture.detectChanges();
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const transport = TestBed.inject(MORSE_TRANSPORT) as TerminalHostTransport;
    // Hidden, but mounted, and no `terminal/close` was sent: the shell lives.
    expect(host.querySelector('morse-bottom-panel')?.classList.contains('host-hidden')).toBe(true);
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(1);
    expect(transport.sent.some((message) => message.type === 'terminal/close')).toBe(false);
  });
});
