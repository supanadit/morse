import { TestBed } from '@angular/core/testing';
import {
  PROTOCOL_VERSION,
  type BotConversationSummary,
  type BotWaitingAsk,
  type ClientToHostMessage,
} from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { QueuedPrompts } from '../../state/queued-prompts';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { ChatComposer } from './composer';

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

  it('queues a compaction that can be reordered or canceled, never edited or sent', async () => {
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
    const promptId = queue.enqueue({ text: 'follow-up', images: [], pins: [] }, 's1');
    const compactionId = queue.enqueueCompaction('keep the schema', 's1');
    fixture.detectChanges();

    // It is queued work like the prompt around it, and it says what it will do.
    expect(rows(host)).toHaveLength(2);
    expect(rows(host)[1]).toContain('Compact context');
    expect(rows(host)[1]).toContain('keep the schema');

    // Only a cancel button: a compaction cannot be edited or sent early.
    const compactionRow = host.querySelector('.queue-row.compaction') as HTMLElement;
    expect(compactionRow.querySelectorAll('button')).toHaveLength(1);
    expect(compactionRow.querySelector('.queue-remove')).not.toBeNull();
    expect(compactionRow.querySelector('.queue-action')).toBeNull();

    // Dragged above the follow-up, it now runs before that message.
    queue.move(compactionId, promptId);
    fixture.detectChanges();
    expect(rows(host)[0]).toContain('Compact context');
    expect(rows(host)[1]).toBe('follow-up');

    // Canceling removes the schedule the same way it removes a message.
    (host.querySelector('.queue-row.compaction .queue-remove') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(rows(host)).toEqual(['follow-up']);
  });
});

describe('ChatComposer waiting for replies', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * A bot room's asks are working elsewhere, so the composer shows them in the
   * same panel a session uses for follow-ups — one row per peer, which opens the
   * thread it is working in.
   */
  it('lists the peers the room is waiting on, and opens their thread', async () => {
    const transport = new QueueHostTransport();
    await TestBed.configureTestingModule({
      imports: [ChatComposer],
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatComposer);
    fixture.componentRef.setInput('variant', 'bot');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const morse = TestBed.inject(MorseService);
    const conversation: BotConversationSummary = {
      id: 'dm-forge',
      kind: 'dm',
      title: 'Forge',
      members: ['forge'],
      chainCap: 8,
      updatedAt: 1,
    };
    const waiting: BotWaitingAsk[] = [
      {
        username: 'loom',
        target: 'Loom',
        conversationId: 'thread-forge-loom',
        deliveryId: 'd1',
        state: 'working',
        at: 10,
        activity: { kind: 'tool', label: 'Reading the brief', at: 20, status: 'running' },
      },
      {
        username: 'sable',
        target: 'Sable',
        conversationId: 'thread-forge-sable',
        deliveryId: 'd2',
        state: 'asked',
        at: 30,
      },
    ];
    morse.bot.onRoster({ bots: [], conversations: [conversation] });
    morse.bot.open(conversation.id);
    morse.bot.onRouting({
      conversationId: conversation.id,
      state: { conversationId: conversation.id, active: [], queued: [], waiting },
    });
    fixture.detectChanges();

    const panel = host.querySelector('.queue.waiting') as HTMLElement;
    expect(panel.textContent?.replace(/\s+/g, ' ')).toContain('Waiting for replies');
    expect(panel.textContent?.replace(/\s+/g, ' ')).toContain('Loom');
    expect(panel.textContent?.replace(/\s+/g, ' ')).toContain('Working');
    expect(panel.textContent?.replace(/\s+/g, ' ')).toContain('Queued');

    const opened = vi.spyOn(morse, 'openBotConversation');
    (panel.querySelectorAll('.waiting-row')[0] as HTMLButtonElement).click();
    expect(opened).toHaveBeenCalledWith('thread-forge-loom');
  });

  it('shows nothing over a session, even when a bot room is waiting', async () => {
    const transport = new QueueHostTransport();
    await TestBed.configureTestingModule({
      imports: [ChatComposer],
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatComposer);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const morse = TestBed.inject(MorseService);
    morse.bot.open('dm-forge');
    morse.bot.onRouting({
      conversationId: 'dm-forge',
      state: {
        conversationId: 'dm-forge',
        active: [],
        queued: [],
        waiting: [
          {
            username: 'loom',
            target: 'Loom',
            conversationId: 'thread-forge-loom',
            deliveryId: 'd1',
            state: 'working',
            at: 10,
          },
        ],
      },
    });
    fixture.detectChanges();

    expect(host.querySelector('.queue.waiting')).toBeNull();
  });
});
