import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type HostCapabilities,
  type SessionViewState,
} from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { ChatComposer } from './composer';

/**
 * The engine pill is a draft choice and a running session fixes its engine, so a
 * config edit is only ever picked up by the engine itself re-reading its own
 * files. That reload cancels pending prompts, which is why a host refuses it
 * mid-turn and answers with the running count: the composer must show that
 * warning itself and only then send the forced request. These lock the control,
 * the warning, and both of its answers down.
 */
interface ReloadAnswer {
  reloaded: boolean;
  requiresConfirmation?: boolean;
  running: number;
}

class ReloadTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  /** Every host command the composer asked for, in order. */
  readonly commands: { command: string; args?: Record<string, unknown> }[] = [];
  /** Answers queued for the next `reloadAgentConfig` requests; the queue refills
   * with a plain success, so a test names only the answer it cares about. */
  readonly replies: ReloadAnswer[] = [];

  constructor(
    private readonly capabilities: HostCapabilities,
    private readonly view: SessionViewState,
  ) {
    super();
  }

  connect(): void {
    this.emitStatus('open');
  }

  send(message: ClientToHostMessage): void {
    if (message.type === 'host/command') {
      this.commands.push({ command: message.payload.command, args: message.payload.args });
      const requestId = message.payload.requestId ?? '';
      const reply = this.replies.shift() ?? { reloaded: true, running: 0 };
      queueMicrotask(() =>
        this.emitMessage({
          type: 'host/command/result',
          payload: { requestId, ok: true, data: reply },
        }),
      );
      return;
    }
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

const CAPABLE: HostCapabilities = {
  ...TWO_ENGINES,
  engines: [{ kind: 'opencode', label: 'OpenCode', default: true, reloadConfig: true }],
};

async function mount(
  transport: ReloadTransport,
): Promise<{ fixture: ComponentFixture<ChatComposer>; host: HTMLElement }> {
  // A test may mount twice to compare two hosts; the reset keeps the second
  // configure/compile honest.
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe('ChatComposer agent config reload', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the reload control only for an engine that offers it', async () => {
    const yes = await mount(new ReloadTransport(CAPABLE, state()));
    expect(yes.host.querySelector('.reload-config')).not.toBeNull();

    const no = await mount(new ReloadTransport(TWO_ENGINES, state()));
    expect(no.host.querySelector('.reload-config')).toBeNull();
  });

  it('warns with the running count, then forces on confirm', async () => {
    const transport = new ReloadTransport(CAPABLE, state());
    transport.replies.push({ reloaded: false, requiresConfirmation: true, running: 2 });
    const { fixture, host } = await mount(transport);
    (host.querySelector('.reload-config') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(host.querySelector('.reload-warning')?.textContent).toContain('2 sessions are running');
    expect(transport.commands.at(-1)).toMatchObject({ command: 'reloadAgentConfig', args: {} });

    (host.querySelector('.reload-confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(transport.commands.at(-1)).toMatchObject({
      command: 'reloadAgentConfig',
      args: { force: true },
    });
  });

  it('cancels without sending a forced reload', async () => {
    const transport = new ReloadTransport(CAPABLE, state());
    transport.replies.push({ reloaded: false, requiresConfirmation: true, running: 1 });
    const { fixture, host } = await mount(transport);
    (host.querySelector('.reload-config') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    (host.querySelector('.reload-cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.reload-warning')).toBeNull();
    expect(transport.commands).toHaveLength(1);
  });
});
