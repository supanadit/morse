import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../../host/transport.token';
import { ChatComposer } from './composer';

/**
 * A host with one prompt template that declares an argument. Clicking its row in
 * the palette must do the same thing Enter does — open the form — instead of
 * inserting `/review ` into the prompt.
 */
class TemplateHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];

  connect(): void {
    this.emitStatus('open');
  }

  send(message: ClientToHostMessage): void {
    this.sent.push(message);
    if (message.type === 'commands/refresh') {
      // The real host answers a refresh with a fresh `session/state`; do the
      // same so a click is tested against the re-render it causes.
      this.emitMessage({
        type: 'session/state',
        payload: {
          workspace: { cwd: '/work/morse', name: 'morse' },
          thinkingLevel: 'off',
          availableModels: [],
          availableThinkingLevels: [],
          availableCommands: [
            {
              name: 'review',
              description: 'Review code changes',
              source: 'prompt',
              template: 'Review ${1:-the staged changes}.',
            },
            {
              name: 'indexing-cbm',
              description: 'Index this repository',
              source: 'prompt',
              template: 'Index this repository.',
            },
          ],
          streaming: false,
          busy: false,
          agentReady: true,
          agentStarting: false,
        },
      });
      return;
    }
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
          insertIntoEditor: false,
          revealFile: false,
        },
        state: {
          workspace: { cwd: '/work/morse', name: 'morse' },
          thinkingLevel: 'off',
          availableModels: [],
          availableThinkingLevels: [],
          availableCommands: [
            {
              name: 'review',
              description: 'Review code changes',
              source: 'prompt',
              template: 'Review ${1:-the staged changes}.',
            },
            {
              name: 'indexing-cbm',
              description: 'Index this repository',
              source: 'prompt',
              template: 'Index this repository.',
            },
          ],
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

async function render(): Promise<{
  host: HTMLElement;
  fixture: ComponentFixture<ChatComposer>;
  transport: TemplateHostTransport;
}> {
  TestBed.resetTestingModule();
  const transport = new TemplateHostTransport();
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture, transport };
}

function openPalette(host: HTMLElement, fixture: ComponentFixture<ChatComposer>): void {
  const textarea = host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
  textarea.value = '/revi';
  textarea.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/** A real pointer click, mousedown through click, not the collapsed `.click()`. */
function pointerClick(element: HTMLElement): void {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
}

describe('ChatComposer palette', () => {
  it('opens the prompt-template form when a row is clicked', async () => {
    const { host, fixture } = await render();
    openPalette(host, fixture);

    const row = host.querySelector('morse-command-picker li button') as HTMLButtonElement;
    expect(row).not.toBeNull();
    pointerClick(row);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(host.querySelector('morse-prompt-template-dialog')).not.toBeNull();
  });

  it('opens the prompt-template form when the row is run with Enter', async () => {
    const { host, fixture } = await render();
    openPalette(host, fixture);

    const textarea = host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(host.querySelector('morse-prompt-template-dialog')).not.toBeNull();
  });

  it('expands an inline-argument template when Enter sends without the palette', async () => {
    const { host, fixture, transport } = await render();
    const textarea = host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
    // The space closes the palette, so Enter goes through `sendWith`, not a row.
    textarea.value = '/review correctness';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelector('morse-command-picker')).toBeNull();

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const prompt = transport.sent.find((message) => message.type === 'chat/prompt');
    expect(prompt?.payload.text).toBe('Review correctness.');
  });

  it('expands a no-argument template when Enter sends without the palette', async () => {
    const { host, fixture, transport } = await render();
    const textarea = host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
    textarea.value = '/indexing-cbm ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const prompt = transport.sent.find((message) => message.type === 'chat/prompt');
    expect(prompt?.payload.text).toBe('Index this repository.');
  });

  it('opens the argument form when Enter sends a bare argument template', async () => {
    const { host, fixture } = await render();
    const textarea = host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
    textarea.value = '/review ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(host.querySelector('morse-prompt-template-dialog')).not.toBeNull();
  });
});
