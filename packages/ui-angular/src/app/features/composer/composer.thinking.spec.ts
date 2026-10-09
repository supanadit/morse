import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage, type SessionViewState } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ChatComposer } from './composer';

/**
 * A model pick re-reads the new model's thinking levels, which pi scopes per
 * current model. While that read is in flight the Send button must be disabled
 * and Enter a no-op: the picker is still settling, and a send that looks like it
 * left with the previous model's level (or is quietly held by the host) reads as
 * a frozen UI. These lock the hold down.
 */
class SettlingHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];
  /** Replays a `session/state` the way the host does when a pick settles. */
  state(state: Partial<SessionViewState>): void {
    this.emitMessage({ type: 'session/state', payload: this.base(state) });
  }

  private base(state: Partial<SessionViewState> = {}): SessionViewState {
    return {
      workspace: { cwd: '/work/morse', name: 'morse' },
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
      busy: false,
      agentReady: true,
      agentStarting: false,
      ...state,
    };
  }

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
        state: this.base(),
      },
    });
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

async function mount(transport: SettlingHostTransport): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>;
  host: HTMLElement;
}> {
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

function sendButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector('.icon.send') as HTMLButtonElement;
}

function prompt(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
}

/** Press Enter the way the composer listens for it. */
function pressEnter(host: HTMLElement): void {
  prompt(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('ChatComposer thinking-levels hold', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('disables Send and swallows Enter while a model pick re-reads its levels', async () => {
    const transport = new SettlingHostTransport();
    const { fixture, host } = await mount(transport);

    transport.state({ loadingThinkingLevels: true });
    fixture.detectChanges();

    prompt(host).value = 'hello';
    prompt(host).dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(sendButton(host).disabled).toBe(true);
    // Enter is a no-op: no prompt left the composer while the pick settled.
    pressEnter(host);
    fixture.detectChanges();
    expect(transport.sent.some((message) => message.type === 'chat/prompt')).toBe(false);
  });

  it('sends again the moment the levels settle', async () => {
    const transport = new SettlingHostTransport();
    const { fixture, host } = await mount(transport);

    transport.state({ loadingThinkingLevels: true });
    fixture.detectChanges();
    prompt(host).value = 'hello';
    prompt(host).dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(sendButton(host).disabled).toBe(true);

    transport.state({ loadingThinkingLevels: false });
    fixture.detectChanges();
    expect(sendButton(host).disabled).toBe(false);

    pressEnter(host);
    fixture.detectChanges();
    expect(transport.sent.some((message) => message.type === 'chat/prompt')).toBe(true);
  });
});
