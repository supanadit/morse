import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type DraftCard,
  type HostCapabilities,
  type SessionViewState,
} from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { ChatComposer } from './composer';

class CardTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];

  constructor(
    private capabilities: HostCapabilities,
    private view: SessionViewState,
    private cards: Record<string, DraftCard>,
  ) {
    super();
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
        user: null,
        capabilities: this.capabilities,
        state: this.view,
      },
    });
    this.emitMessage({ type: 'draft/cards', payload: { cards: this.cards } });
  }

  /** Replays a state the way the host does after a pick. */
  state(next: Partial<SessionViewState>): void {
    this.view = { ...this.view, ...next };
    this.emitMessage({ type: 'session/state', payload: this.view });
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

function draftState(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return {
    workspace: { cwd: '/work/morse', name: 'morse' },
    draft: true,
    thinkingLevel: 'off',
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    streaming: false,
    busy: false,
    agentReady: false,
    agentStarting: false,
    ...overrides,
  };
}

const TWO_ENGINES: HostCapabilities = {
  hostKind: 'server',
  scope: 'global',
  editorContext: false,
  nativeDialogs: false,
  insertIntoEditor: false,
  revealFile: false,
  engines: [
    { kind: 'pi', label: 'pi', default: true },
    { kind: 'opencode', label: 'OpenCode' },
  ],
};

/**
 * A draft tab restores its persisted composition: the picks the host saved
 * under the tab's key are replayed into the host's draft memory, so the
 * pickers show the last choice instead of the defaults — after a reload, a
 * reconnect, or on another device with the same tab.
 */
describe('ChatComposer draft restore', () => {
  async function mount(
    transport: CardTransport,
  ): Promise<{ fixture: ComponentFixture<ChatComposer>; host: HTMLElement }> {
    await TestBed.configureTestingModule({
      imports: [ChatComposer],
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatComposer);
    fixture.detectChanges();
    return { fixture, host: fixture.nativeElement as HTMLElement };
  }

  async function settle(fixture: ComponentFixture<ChatComposer>): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('replays a saved engine pick into the draft, once', async () => {
    const transport = new CardTransport(TWO_ENGINES, draftState(), {
      'draft-1': { engine: 'opencode' },
    });
    const { fixture } = await mount(transport);
    TestBed.inject(WorkspaceTabs).openDraft('/work/morse');
    await settle(fixture);

    const picks = transport.sent.filter((message) => message.type === 'engine/set');
    expect(picks).toEqual([
      { type: 'engine/set', payload: { kind: 'opencode', draftKey: 'draft-1' } },
    ]);

    // The host echoing the pick back stops the replay instead of looping it.
    transport.state({ engine: 'opencode' });
    await settle(fixture);
    expect(transport.sent.filter((message) => message.type === 'engine/set')).toHaveLength(1);
  });

  it('ignores a card for an engine that is no longer installed', async () => {
    const transport = new CardTransport(TWO_ENGINES, draftState(), {
      'draft-1': { engine: 'gone' },
    });
    const { fixture } = await mount(transport);
    TestBed.inject(WorkspaceTabs).openDraft('/work/morse');
    await settle(fixture);

    expect(transport.sent.filter((message) => message.type === 'engine/set')).toEqual([]);
  });

  it('leaves a draft with no card on the host defaults', async () => {
    const transport = new CardTransport(TWO_ENGINES, draftState(), {});
    const { fixture } = await mount(transport);
    TestBed.inject(WorkspaceTabs).openDraft('/work/morse');
    await settle(fixture);

    expect(
      transport.sent.filter((message) =>
        ['engine/set', 'mode/set', 'model/set', 'thinking/set'].includes(message.type),
      ),
    ).toEqual([]);
  });
});
