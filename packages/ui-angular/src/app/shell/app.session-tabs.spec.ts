import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage, type SessionViewState } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { MORSE_TRANSPORT } from '../host/transport.token';

/**
 * A browser host with the tab strip on. The point: `session/state` carries no
 * `sessionTitle` (it never does), so a tab must take its label from the session
 * list the sidebar reads, not fall back to "New session".
 */
class TitledSessionTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  /** `false` models a host with no notification channel of its own (the web). */
  constructor(private readonly hostCanNotify = true) {
    super();
  }

  connect(): void {
    this.emitStatus('open');
  }

  dispose(): void {
    this.emitStatus('closed');
  }

  /** The host dropped to an empty draft, e.g. a session closed elsewhere. */
  dropToDraft(): void {
    this.emitMessage({
      type: 'session/state',
      payload: {
        workspace: { cwd: '/work/morse', name: 'morse' },
        thinkingLevel: 'off',
        availableModels: [],
        availableThinkingLevels: [],
        availableCommands: [],
        streaming: false,
        busy: false,
        agentReady: false,
        agentStarting: false,
      },
    });
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
          notify: this.hostCanNotify,
        },
        state: this.activeState(),
      },
    });
    this.emitMessage({
      type: 'session/list',
      payload: {
        sessions: [
          { id: 'session-1', title: 'Sekarang tampilan tool', cwd: '/work/morse', updatedAt: 1, messageCount: 3 },
        ],
      },
    });
  }

  /** A live state update that carries pi's configuration warnings. */
  showDiagnostics(): void {
    this.emitMessage({
      type: 'session/state',
      payload: {
        ...this.activeState(),
        diagnostics: [
          {
            level: 'warn',
            text: 'Prompt template /home/u/.pi/agent/prompts/explain-path.md is not loaded by pi: Nested mappings are not allowed in compact mappings at line 1, column 14',
          },
        ],
      },
    });
  }

  private activeState(): SessionViewState {
    return {
      sessionId: 'session-1',
      sessionTitle: 'Sekarang tampilan tool',
      workspace: { cwd: '/work/morse', name: 'morse' },
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
      busy: false,
      agentReady: true,
      agentStarting: false,
    };
  }
}

function render(): ComponentFixture<App> {
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return fixture;
}

describe('App session tabs', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('labels an existing session tab with the title the host lists', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TitledSessionTransport() }],
    });
    const fixture = render();

    const label = fixture.nativeElement.querySelector('.tab .label')?.textContent?.trim();
    expect(label).toBe('Sekarang tampilan tool');
  });

  it('clears the active tab when the host drops to an empty draft', () => {
    const transport = new TitledSessionTransport();
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
    });
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.tab.active')).not.toBeNull();

    transport.dropToDraft();
    fixture.detectChanges();

    // The stale tab stays, but it must not look like the conversation on screen.
    expect(fixture.nativeElement.querySelectorAll('.tab')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.tab.active')).toBeNull();
  });

  it('nudges for notifications once, and remembers the answer', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TitledSessionTransport() }],
    });
    const fixture = render();
    const banner = () => fixture.nativeElement.querySelector('.notify-prompt') as HTMLElement | null;

    expect(banner()).not.toBeNull();
    (banner()!.querySelector('.notify-on') as HTMLButtonElement).click();
    fixture.detectChanges();

    // Answering it (here: turning it on) retires the nudge for good.
    expect(banner()).toBeNull();
  });

  it('comes back when the permission is reset after opting in', () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TitledSessionTransport(false) }],
    });
    const fixture = render();
    const banner = () => fixture.nativeElement.querySelector('.notify-prompt') as HTMLElement | null;

    // Opt in while the browser is granting: the nudge goes away.
    (banner()!.querySelector('.notify-on') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(banner()).toBeNull();

    // The site setting is reset from the browser; coming back re-reads it, and
    // the panel has to say the notification is not actually going through.
    (globalThis as unknown as { Notification: { permission: string } }).Notification.permission = 'denied';
    window.dispatchEvent(new Event('focus'));
    fixture.detectChanges();

    expect(banner()?.textContent).toContain('blocked for this site');
  });

  it('shows pi configuration warnings as a row, with the files behind Details', () => {
    const transport = new TitledSessionTransport();
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
    });
    const fixture = render();
    const row = () => fixture.nativeElement.querySelector('.diagnostics') as HTMLElement | null;

    // Nothing to say until pi reports one.
    expect(row()).toBeNull();

    transport.showDiagnostics();
    fixture.detectChanges();

    expect(row()?.textContent).toContain('1 configuration warning');
    // Collapsed: the file list is not painted until it is asked for.
    expect(row()!.querySelector('.diagnostics-list')).toBeNull();

    (row()!.querySelector('.diagnostics-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(row()!.querySelector('.diagnostics-list')?.textContent).toContain('explain-path.md');
  });

  it('hides the chat and offers a session when no tab is in front', () => {
    const transport = new TitledSessionTransport();
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
    });
    const fixture = render();
    expect(fixture.nativeElement.querySelector('textarea')).toBeTruthy();

    transport.dropToDraft();
    fixture.detectChanges();

    // No conversation to read and none to send: the composer is gone, not merely
    // disabled, and the panel says what to do instead of showing a hero.
    expect(fixture.nativeElement.querySelector('textarea')).toBeNull();
    expect(fixture.nativeElement.querySelector('morse-empty-session')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('morse-empty-session')?.textContent).toContain(
      'Pick a session from the tabs above',
    );
  });

  it('starts a session from the placeholder when no tab is open at all', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TitledSessionTransport() }],
    });
    const fixture = render();

    // Close the only tab: the strip is empty, so there is nothing to pick.
    (fixture.nativeElement.querySelector('.tab .close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.tab')).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('morse-empty-session')?.textContent).toContain(
      'Start a new session',
    );

    // Its button runs the sidebar's own "New session" (a draft tab, then the chat).
    (fixture.nativeElement.querySelector('morse-empty-session button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.tab')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('morse-empty-session')).toBeNull();
    expect(fixture.nativeElement.querySelector('textarea')).toBeTruthy();
  });

  it('closing the last session tab leaves the strip empty for good', () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TitledSessionTransport() }],
    });
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('.tab')).toHaveLength(1);

    (fixture.nativeElement.querySelector('.tab .close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.tab')).toHaveLength(0);

    // The host keeps the same session active and re-emits; a closed tab must not
    // come back just because an effect saw the session again.
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.tab')).toHaveLength(0);
  });
});
