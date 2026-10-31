import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ChatComposer } from './composer';

/** Answers the handshake so the composer renders in its normal, ready shape. */
class ReadyHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];

  connect(): void {
    this.emitStatus('open');
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

async function mount(): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>;
  host: HTMLElement;
  transport: ReadyHostTransport;
}> {
  const transport = new ReadyHostTransport();
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, transport };
}

/** Sends the prompt the way the host would see it: only a `prompt/send`-shaped message counts. */
function prompts(transport: ReadyHostTransport): ClientToHostMessage[] {
  return transport.sent.filter((message) => message.type !== 'client/ready');
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

  it('writes a new line on Enter while maximized, and sends on Shift+Enter', async () => {
    const { fixture, host, transport } = await mount();
    (host.querySelector('button[aria-pressed="false"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'hello';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(prompts(transport)).toHaveLength(0);

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(prompts(transport)).toHaveLength(1);
  });

  it('shows the shortcut legend only in full screen', async () => {
    const { fixture, host } = await mount();
    expect(host.querySelector('.legend')).toBeNull();

    (host.querySelector('button[aria-pressed="false"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.legend')?.textContent).toContain('Shift');
  });
});

function press(element: Element, type: string, clientY = 0): void {
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }),
  );
}
