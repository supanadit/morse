import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { MORSE_TRANSPORT } from './core/transport.token';

/**
 * A browser host with the tab strip on. The point: `session/state` carries no
 * `sessionTitle` (it never does), so a tab must take its label from the session
 * list the sidebar reads, not fall back to "New session".
 */
class TitledSessionTransport extends BaseHostTransport {
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
    this.emitMessage({
      type: 'session/list',
      payload: {
        sessions: [
          { id: 'session-1', title: 'Sekarang tampilan tool', cwd: '/work/morse', updatedAt: 1, messageCount: 3 },
        ],
      },
    });
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
