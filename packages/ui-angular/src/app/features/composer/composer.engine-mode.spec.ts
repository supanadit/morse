import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage, type HostCapabilities, type SessionViewState } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ChatComposer } from './composer';

/**
 * The engine pill is a draft choice (an engine cannot change under a running
 * conversation), while the mode pill belongs to a harness that reports modes and
 * stays available for the whole conversation. These lock those rules and the
 * messages the composer sends.
 */
class PickersTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  readonly sent: ClientToHostMessage[] = [];

  constructor(
    private capabilities: HostCapabilities,
    private view: SessionViewState,
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
        capabilities: this.capabilities,
        state: this.view,
      },
    });
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

function state(overrides: Partial<SessionViewState> = {}): SessionViewState {
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

const MODES = [
  { id: 'build', name: 'Build', description: 'The default agent', default: true },
  { id: 'plan', name: 'Plan', description: 'Think first' },
];

async function mount(
  transport: PickersTransport,
): Promise<{ fixture: ComponentFixture<ChatComposer>; host: HTMLElement }> {
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

function picker(host: HTMLElement, which: 'engine' | 'mode'): HTMLElement | null {
  return host.querySelector(`.${which}-host`) as HTMLElement | null;
}

function trigger(host: HTMLElement, which: 'engine' | 'mode'): HTMLButtonElement {
  return picker(host, which)?.querySelector('.trigger') as HTMLButtonElement;
}

function rows(host: HTMLElement, which: 'engine' | 'mode'): HTMLButtonElement[] {
  return [...(picker(host, which)?.querySelectorAll<HTMLButtonElement>('.row') ?? [])];
}

describe('ChatComposer engine and mode pills', () => {
  it('offers the engine only in a draft with more than one engine', async () => {
    const many = new PickersTransport(TWO_ENGINES, state());
    const { fixture, host } = await mount(many);
    expect(picker(host, 'engine')).not.toBeNull();
    expect(picker(host, 'mode')).toBeNull();

    trigger(host, 'engine').click();
    fixture.detectChanges();
    expect(rows(host, 'engine').map((row) => row.textContent)).toEqual([
      expect.stringContaining('pi'),
      expect.stringContaining('OpenCode'),
    ]);
    rows(host, 'engine')[1]?.click();
    expect(many.sent).toContainEqual({ type: 'engine/set', payload: { kind: 'opencode' } });
  });

  it('hides the engine pill when only one engine is installed', async () => {
    const { host } = await mount(
      new PickersTransport(
        { ...TWO_ENGINES, engines: [{ kind: 'pi', label: 'pi', default: true }] },
        state(),
      ),
    );
    expect(picker(host, 'engine')).toBeNull();
  });

  it('hides the engine pill once a session exists, but keeps the mode pill', async () => {
    const transport = new PickersTransport(
      TWO_ENGINES,
      state({ sessionId: 'sess-1', draft: false, mode: 'build', availableModes: MODES }),
    );
    const { host } = await mount(transport);

    expect(picker(host, 'engine')).toBeNull();
    expect(picker(host, 'mode')).not.toBeNull();
    expect(trigger(host, 'mode').textContent).toContain('Build');
  });

  it('picks a mode and refreshes the catalog when the panel opens', async () => {
    const transport = new PickersTransport(
      TWO_ENGINES,
      state({ draft: false, sessionId: 'sess-1', mode: 'build', availableModes: MODES }),
    );
    const { fixture, host } = await mount(transport);

    trigger(host, 'mode').click();
    fixture.detectChanges();
    expect(transport.sent).toContainEqual({ type: 'modes/refresh', payload: {} });
    expect(rows(host, 'mode').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Build'),
      expect.stringContaining('Plan'),
    ]);

    rows(host, 'mode')[1]?.click();
    expect(transport.sent).toContainEqual({ type: 'mode/set', payload: { mode: 'plan' } });
  });

  it('holds Send while a newly chosen engine is being read', async () => {
    const transport = new PickersTransport(TWO_ENGINES, state());
    const { fixture, host } = await mount(transport);
    expect((host.querySelector('.icon.send') as HTMLButtonElement).disabled).toBe(false);

    transport.state({ loadingEngine: true });
    fixture.detectChanges();
    expect((host.querySelector('.icon.send') as HTMLButtonElement).disabled).toBe(true);
  });
});
