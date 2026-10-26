import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ChatComposer } from './composer';

/** Answers the handshake so the composer renders in its normal, ready shape. */
class ReadyHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  connect(): void {
    this.emitStatus('open');
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
          editorContext: false,
          nativeDialogs: false,
          insertIntoEditor: false,
          revealFile: false,
        },
        state: {
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

  dispose(): void {
    this.emitStatus('closed');
  }
}

async function mount(): Promise<{ fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>; host: HTMLElement }> {
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: new ReadyHostTransport() }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe('ChatComposer sizing', () => {
  it('maximizes from the toolbar button and shrinks back on Escape', async () => {
    const { fixture, host } = await mount();
    const maximize = host.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!;
    expect(maximize).toBeTruthy();

    maximize.click();
    fixture.detectChanges();
    expect(host.classList.contains('maximized')).toBe(true);

    const textarea = host.querySelector('textarea')!;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(host.classList.contains('maximized')).toBe(false);
  });

  it('sizes the prompt from a drag on the top edge', async () => {
    const { fixture, host } = await mount();
    const grip = host.querySelector('.resize') as HTMLElement;
    expect(grip).toBeTruthy();

    // Pulling up from the top edge grows the prompt (60 floor + 120).
    press(grip, 'pointerdown', 300);
    press(grip, 'pointermove', 180);
    press(grip, 'pointerup', 180);
    fixture.detectChanges();

    const textarea = host.querySelector('textarea') as HTMLElement;
    expect(textarea.style.height).toBe('180px');
  });
});

function press(element: Element, type: string, clientY = 0): void {
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }),
  );
}
