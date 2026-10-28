import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../../state/attachments';
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

async function mount() {
  const transport = new ReadyHostTransport();
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, store: TestBed.inject(AttachmentStore) };
}

function chipLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.chip:not(.live) .chip-lines')].map(
    (node) => node.textContent?.trim() ?? '',
  );
}

describe('ChatComposer attachment chips', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('labels a column pin with its exact columns and explains it in the tooltip', async () => {
    const { fixture, host, store } = await mount();
    store.pin({
      path: 'src/app.ts',
      startLine: 18,
      endLine: 18,
      startColumn: 45,
      endColumn: 79,
      characters: 35,
      text: 'the highlighted words of one line',
    });
    fixture.detectChanges();

    expect(chipLabels(host)).toEqual(['L18:45-79']);
    const title = host.querySelector('.chip:not(.live) .chip-body')?.getAttribute('title') ?? '';
    expect(title).toContain('src/app.ts');
    expect(title).toContain('line 18, columns 45-79');
    expect(title).toContain('35 selected');
    expect(title).toContain('the highlighted words of one line');
  });

  it('keeps the whole-line label for a pin without columns', async () => {
    const { fixture, host, store } = await mount();
    store.pin({ path: 'src/lines.ts', startLine: 18, endLine: 20 });
    fixture.detectChanges();

    expect(chipLabels(host)).toEqual(['L18-20']);
    const title = host.querySelector('.chip:not(.live) .chip-body')?.getAttribute('title') ?? '';
    expect(title).toContain('lines 18-20');
  });

  it('shows a whole-file pin with no range label', async () => {
    const { fixture, host, store } = await mount();
    store.pin({ path: 'src/whole.ts' });
    fixture.detectChanges();

    expect(chipLabels(host)).toEqual([]);
    const name = host.querySelector('.chip:not(.live) .chip-name')?.textContent?.trim();
    expect(name).toBe('src/whole.ts');
  });
});
