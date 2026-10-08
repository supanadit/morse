import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type HostCapabilities,
  type SessionViewState,
} from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { describe, expect, it } from 'vitest';
import { App } from '../../../shell/app';
import { MORSE_TRANSPORT } from '../../../host/transport.token';
import { AgentScreen } from './agent-screen';

const INSTALL = 'npm install -g @earendil-works/pi-coding-agent';
const HINT = 'Set "morse.pi.path" or install the pi CLI so that it is on PATH.';
const MESSAGE = [
  'The pi coding agent was not found.',
  `Install it (\`${INSTALL}\`) or point Morse at it:`,
  '- VS Code: setting "morse.pi.path"',
].join('\n');

/**
 * The state this screen exists for: a host that is up, an agent that never
 * started, and a transcript the reader may or may not have. Nothing here spawns
 * pi or reaches a model.
 */
class MissingAgentTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;
  /** Everything the frontend asked for, so a test can assert the action taken. */
  readonly sent: ClientToHostMessage[] = [];

  constructor(
    private readonly hostKind: 'server' | 'vscode',
    /** A resumed session: history on screen, agent still down. */
    private readonly withTranscript = false,
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
    const state: SessionViewState = {
      workspace: { cwd: '/work/morse', name: 'morse' },
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
      busy: false,
      agentReady: false,
      agentStarting: false,
      agentError: MESSAGE,
      agentFailure: { code: 'agent-unavailable', install: INSTALL, hint: HINT },
    };
    this.emitMessage({
      type: 'host/ready',
      payload: { protocolVersion: PROTOCOL_VERSION, capabilities: capabilities(this.hostKind), state },
    });
    if (this.withTranscript) {
      this.emitMessage({
        type: 'transcript/append',
        payload: { id: 'u1', at: 1, kind: 'user', text: 'what changed yesterday?' },
      });
    }
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

function capabilities(hostKind: 'server' | 'vscode'): HostCapabilities {
  const scoped = hostKind === 'vscode';
  return {
    hostKind,
    scope: scoped ? 'workspace' : 'global',
    editorContext: scoped,
    nativeDialogs: scoped,
    insertIntoEditor: scoped,
    revealFile: scoped,
  };
}

async function renderScreen(hostKind: 'server' | 'vscode'): Promise<{
  host: HTMLElement;
  fixture: ComponentFixture<AgentScreen>;
  transport: MissingAgentTransport;
}> {
  TestBed.resetTestingModule();
  const transport = new MissingAgentTransport(hostKind);
  await TestBed.configureTestingModule({
    imports: [AgentScreen],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(AgentScreen);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture, transport };
}

async function renderApp(withTranscript: boolean): Promise<{
  host: HTMLElement;
  transport: MissingAgentTransport;
}> {
  TestBed.resetTestingModule();
  const transport = new MissingAgentTransport('server', withTranscript);
  await TestBed.configureTestingModule({
    imports: [App],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, transport };
}

describe('AgentScreen', () => {
  it('offers the command the adapter named, plus the host’s own next step', async () => {
    const { host } = await renderScreen('server');

    expect(host.textContent).toContain('The pi coding agent is not installed');
    expect(host.querySelector('.command code')?.textContent?.trim()).toBe(INSTALL);
    expect(host.textContent).toContain(HINT);
    // The raw failure is one click away, not the headline.
    expect(host.querySelector('details pre')?.textContent).toContain('was not found');

    // A browser host has no settings dialog: it gets the restart advice instead.
    expect(host.textContent).toContain('MORSE_PI_PATH');
    expect(host.textContent).not.toContain('Reload the window');
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === 'Open settings'),
    ).toBe(false);
  });

  it('copies the install command and confirms it in place', async () => {
    const { host, fixture } = await renderScreen('server');
    const copy = host.querySelector('.command button') as HTMLButtonElement;
    expect(copy.textContent?.trim()).toBe('Copy');

    copy.click();
    fixture.detectChanges();
    expect(copy.textContent?.trim()).toBe('Copied');
  });

  it('sends VS Code to its settings and output instead of a restart', async () => {
    const { host, fixture, transport } = await renderScreen('vscode');
    expect(host.textContent).toContain('Reload the window');

    const button = (label: string): HTMLButtonElement =>
      [...host.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === label,
      ) as HTMLButtonElement;

    button('Open settings').click();
    fixture.detectChanges();
    button('Show log').click();

    const commands = transport.sent
      .filter((message) => message.type === 'host/command')
      .map((message) => (message.payload as { command: string }).command);
    expect(commands).toEqual(['openSettings', 'showOutput']);
  });

  it('retries by asking for a new session — that is what spawns pi again', async () => {
    const { host, transport } = await renderScreen('server');

    // The primary action is first in the card (a browser host has no settings dialog).
    const retry = host.querySelector('.actions button') as HTMLButtonElement;
    expect(retry.textContent?.trim()).toBe('Retry');
    retry.click();

    expect(transport.sent.filter((message) => message.type === 'session/new')).toHaveLength(1);
  });
});

/**
 * The branch that decides *where* the failure is shown: an empty panel has
 * nothing to lose, so the screen takes it; a transcript is still worth reading
 * with the agent down, so the failure shrinks to a bar above it.
 */
describe('App · agent failure', () => {
  it('gives the empty panel to the setup screen', async () => {
    const { host } = await renderApp(false);

    expect(host.querySelector('morse-agent-screen')).not.toBeNull();
    // The hero ("Ask Morse…") and a disabled composer would both be lies here.
    expect(host.querySelector('morse-chat-transcript')).toBeNull();
    expect(host.querySelector('morse-chat-composer')).toBeNull();
    expect(host.querySelector('.alert')).toBeNull();
  });

  it('keeps the transcript and shrinks the failure to a bar', async () => {
    const { host } = await renderApp(true);

    expect(host.querySelector('morse-agent-screen')).toBeNull();
    expect(host.querySelector('morse-chat-transcript')).not.toBeNull();
    expect(host.querySelector('morse-chat-composer')).not.toBeNull();
    const banner = host.querySelector('.alert');
    expect(banner?.textContent).toContain('Pi agent unavailable');
    expect(banner?.textContent).toContain('was not found');
  });
});
