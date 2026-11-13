import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { LayoutState } from '../state/layout-state';
import { ShellState } from '../state/shell-state';
import { MORSE_TRANSPORT } from '../host/transport.token';

class RailHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  constructor(
    private readonly sessionId: string | null = 'session-1',
    private readonly filePreview = true,
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
          ...(this.filePreview ? { filePreview: true } : {}),
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

function render(sessionId: string | null = 'session-1', filePreview = true) {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      { provide: MORSE_TRANSPORT, useFactory: () => new RailHostTransport(sessionId, filePreview) },
    ],
  });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return fixture;
}

function entries(fixture: ComponentFixture<App>): HTMLButtonElement[] {
  return [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll('morse-activity-rail .entry'),
  ] as HTMLButtonElement[];
}

describe('App left rail', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('opens on the session list behind the rail', () => {
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;
    const nav = host.querySelector('morse-session-nav') as HTMLElement;

    expect(host.querySelector('morse-activity-rail')).not.toBeNull();
    expect(nav).not.toBeNull();
    expect(nav.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('morse-file-explorer')).toBeNull();
  });

  it('swaps the column to Files and back, keeping the handle', () => {
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;

    entries(fixture)[1].click();
    fixture.detectChanges();
    const explorer = host.querySelector('morse-file-explorer') as HTMLElement;
    expect(explorer).not.toBeNull();
    expect(explorer.hasAttribute('hidden')).toBe(false);
    expect((host.querySelector('morse-session-nav') as HTMLElement).hasAttribute('hidden')).toBe(
      true,
    );
    expect(host.querySelector('.nav .edge-resize')).not.toBeNull();

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect((host.querySelector('morse-session-nav') as HTMLElement).hasAttribute('hidden')).toBe(
      false,
    );
  });

  it('keeps the rail when the column folds', () => {
    const fixture = render();
    TestBed.inject(LayoutState).setVisible('left', false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('morse-activity-rail')).not.toBeNull();
    expect((host.querySelector('morse-session-nav') as HTMLElement).hasAttribute('hidden')).toBe(
      false,
    );

    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(TestBed.inject(LayoutState).leftCollapsed()).toBe(false);
    expect(host.querySelector('morse-file-explorer')).not.toBeNull();
  });

  it('applies a stored Files view', () => {
    localStorage.setItem('morse.left.pane', 'files');
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;

    expect(TestBed.inject(ShellState).leftPane()).toBe('files');
    expect((host.querySelector('morse-file-explorer') as HTMLElement).hasAttribute('hidden')).toBe(
      false,
    );
  });

  it('does not mount the rail without filePreview, even with a stored Files view', () => {
    localStorage.setItem('morse.left.pane', 'files');
    const fixture = render('session-1', false);
    const host = fixture.nativeElement as HTMLElement;
    const nav = host.querySelector('morse-session-nav') as HTMLElement;

    expect(host.querySelector('morse-activity-rail')).toBeNull();
    expect(nav).not.toBeNull();
    expect(nav.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('morse-file-explorer')).toBeNull();
  });

  it('shows the Explorer with no session in front', () => {
    const fixture = render(null);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('morse-empty-session')).not.toBeNull();
    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(host.querySelector('morse-file-explorer')).not.toBeNull();
  });

  it("keeps the session view's state across a swap", () => {
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;
    const search = host.querySelector(
      'morse-session-nav input[type="search"]',
    ) as HTMLInputElement;

    search.value = 'rail';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    entries(fixture)[1].click();
    fixture.detectChanges();
    entries(fixture)[0].click();
    fixture.detectChanges();

    const again = host.querySelector(
      'morse-session-nav input[type="search"]',
    ) as HTMLInputElement;
    expect(again.value).toBe('rail');
  });
});
