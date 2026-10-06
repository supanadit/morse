import { TestBed } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { QueuedPrompts } from '../../core/queued-prompts';
import { MORSE_TRANSPORT } from '../../core/transport.token';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { ChatComposer } from './chat-composer';

/** A bare memory host: enough for the composer to mount and read its state. */
class QueueHostTransport extends BaseHostTransport {
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
          // Busy, which is when a follow-up is queued instead of sent: an idle
          // shell drains the queue at once, so the leak test needs a run.
          streaming: true,
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

function rows(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.queue-text')].map((node) => node.textContent?.trim() ?? '');
}

describe('ChatComposer queued messages', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * The queue is shell state shared by every session; the composer must show only
   * the tab in front, or a follow-up queued in one session leaks into another.
   */
  it('shows only the active tab queue, and follows a tab switch', async () => {
    const transport = new QueueHostTransport();
    await TestBed.configureTestingModule({
      imports: [ChatComposer],
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatComposer);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const queue = TestBed.inject(QueuedPrompts);
    const tabs = TestBed.inject(WorkspaceTabs);

    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    fixture.detectChanges();
    queue.enqueue({ text: 'for s1', images: [], pins: [] }, 's1');
    queue.enqueue({ text: 'for s2', images: [], pins: [] }, 's2');
    fixture.detectChanges();

    expect(queue.forOwner('s1')).toHaveLength(1);
    expect(tabs.composerKey()).toBe('s1');
    expect(rows(host)).toEqual(['for s1']);
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/repo' });
    fixture.detectChanges();

    expect(rows(host)).toEqual(['for s2']);
  });

  it('reorders the queue to the slot CDK reports the row was dropped on', async () => {
    const transport = new QueueHostTransport();
    await TestBed.configureTestingModule({
      imports: [ChatComposer],
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatComposer);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const queue = TestBed.inject(QueuedPrompts);
    const tabs = TestBed.inject(WorkspaceTabs);

    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    fixture.detectChanges();
    queue.enqueue({ text: 'first', images: [], pins: [] }, 's1');
    queue.enqueue({ text: 'second', images: [], pins: [] }, 's1');
    fixture.detectChanges();
    expect(rows(host)).toEqual(['first', 'second']);

    // A CDK drop carries the list as it was at drag start plus the landed index.
    const row = queue.forOwner('s1');
    (
      fixture.componentInstance as unknown as {
        onQueueDrop: (event: {
          item: { data: unknown };
          container: { data: readonly unknown[] };
          currentIndex: number;
        }) => void;
      }
    ).onQueueDrop({ item: { data: row[0] }, container: { data: row }, currentIndex: 1 });
    fixture.detectChanges();

    expect(rows(host)).toEqual(['second', 'first']);
  });
});
