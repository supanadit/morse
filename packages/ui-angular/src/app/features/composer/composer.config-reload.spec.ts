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
   * with a plain success, so a test names only the answer it cares about. An
   * explicit `undefined` stands for the host's `ok: false` (the engine threw),
   * which the client resolves as `undefined` too. */
  readonly replies: (ReloadAnswer | undefined)[] = [];

  constructor(
    private readonly capabilities: HostCapabilities,
    private view: SessionViewState,
  ) {
    super();
  }

  connect(): void {
    this.emitStatus('open');
  }

  /** Replays a state the way the host does after a pick or a session switch. */
  state(next: Partial<SessionViewState>): void {
    this.view = { ...this.view, ...next };
    this.emitMessage({ type: 'session/state', payload: this.view });
  }

  send(message: ClientToHostMessage): void {
    if (message.type === 'host/command') {
      this.commands.push({ command: message.payload.command, args: message.payload.args });
      const requestId = message.payload.requestId ?? '';
      const reply = this.replies.length > 0 ? this.replies.shift() : { reloaded: true, running: 0 };
      queueMicrotask(() =>
        this.emitMessage({
          type: 'host/command/result',
          payload:
            reply === undefined
              ? { requestId, ok: false, error: 'reload failed' }
              : { requestId, ok: true, data: reply },
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
        user: null,
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

/**
 * The fake host answers from a microtask the fixture does not track, so
 * `whenStable` can resume the test before the request's continuation writes the
 * signal. One extra microtask turn lets that land before the DOM is read.
 */
async function settle(fixture: ComponentFixture<ChatComposer>): Promise<void> {
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
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
    // The request is in flight until the host answers: the control must be off
    // before the reply lands, which is what the disabled binding and spin say.
    fixture.detectChanges();
    expect((host.querySelector('.reload-config') as HTMLButtonElement).disabled).toBe(true);
    await settle(fixture);
    expect(host.querySelector('.reload-warning')?.textContent).toContain('2 sessions are running');
    expect((host.querySelector('.reload-config') as HTMLButtonElement).disabled).toBe(false);
    // toEqual, not toMatchObject: `{ force: false }` must fail here.
    expect(transport.commands.at(-1)).toEqual({ command: 'reloadAgentConfig', args: {} });

    (host.querySelector('.reload-confirm') as HTMLButtonElement).click();
    await settle(fixture);
    expect(transport.commands.at(-1)).toEqual({
      command: 'reloadAgentConfig',
      args: { force: true },
    });
  });

  it('does nothing when the engine cannot reload', async () => {
    // The host answers `{ reloaded: false }` with no confirmation when its engine
    // has no reload to run. That is not a running-session refusal, so no warning
    // (and certainly not a bogus "0 sessions are running") may appear.
    const transport = new ReloadTransport(CAPABLE, state());
    transport.replies.push({ reloaded: false, running: 2 });
    const { fixture, host } = await mount(transport);
    (host.querySelector('.reload-config') as HTMLButtonElement).click();
    await settle(fixture);
    expect(host.querySelector('.reload-warning')).toBeNull();
    expect(host.querySelector('.reload-error')).toBeNull();
    expect(transport.commands.at(-1)).toEqual({ command: 'reloadAgentConfig', args: {} });
  });

  it('cancels without sending a forced reload', async () => {
    const transport = new ReloadTransport(CAPABLE, state());
    transport.replies.push({ reloaded: false, requiresConfirmation: true, running: 1 });
    const { fixture, host } = await mount(transport);
    (host.querySelector('.reload-config') as HTMLButtonElement).click();
    await settle(fixture);
    (host.querySelector('.reload-cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.reload-warning')).toBeNull();
    expect(transport.commands).toHaveLength(1);
  });

  it('surfaces a reload the host could not complete', async () => {
    // The host answers `ok: false` when the engine throws (an invalid config after
    // an edit is the likely one). The client resolves that — and a timeout — as
    // `undefined`, which must not read as a silent success.
    const transport = new ReloadTransport(CAPABLE, state());
    transport.replies.push(undefined);
    const { fixture, host } = await mount(transport);
    (host.querySelector('.reload-config') as HTMLButtonElement).click();
    await settle(fixture);
    expect(host.querySelector('.reload-error')?.textContent).toContain(
      'The agent configuration could not be reloaded.',
    );
    expect(host.querySelector('.reload-warning')).toBeNull();

    (host.querySelector('.reload-error-dismiss') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.reload-error')).toBeNull();
  });

  it('drops a stale warning when the session changes', async () => {
    // The shell keeps one composer across sessions, so a warning naming the old
    // session's running turns must not authorize a forced reload for the new one.
    const transport = new ReloadTransport(CAPABLE, state());
    transport.replies.push({ reloaded: false, requiresConfirmation: true, running: 1 });
    const { fixture, host } = await mount(transport);
    (host.querySelector('.reload-config') as HTMLButtonElement).click();
    await settle(fixture);
    expect(host.querySelector('.reload-warning')).not.toBeNull();

    transport.state({ sessionId: 'sess-2', draft: false });
    await settle(fixture);
    expect(host.querySelector('.reload-warning')).toBeNull();
    expect(transport.commands).toHaveLength(1);
  });
});
