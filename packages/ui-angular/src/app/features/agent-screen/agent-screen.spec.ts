import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type EngineSetupOption,
  type HostCapabilities,
  type SessionViewState,
} from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { describe, expect, it } from 'vitest';
import { App } from '../../shell/app';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { AgentScreen } from './agent-screen';

const INSTALL = 'npm install -g @earendil-works/pi-coding-agent';
const HINT = 'Set "morse.pi.path" or install the pi CLI so that it is on PATH.';
const MESSAGE = [
  'The pi coding agent was not found.',
  `Install it (\`${INSTALL}\`) or point Morse at it:`,
  '- VS Code: setting "morse.pi.path"',
].join('\n');
const OPENCODE_INSTALL = 'npm install -g @opencode/cli';
/** What a host with nothing installed reports: no engine to blame, both installs offered. */
const SETUP: EngineSetupOption[] = [
  {
    kind: 'pi',
    label: 'pi',
    install: INSTALL,
    hint: 'Set "morse.pi.path", or install pi so it is on PATH.',
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    install: OPENCODE_INSTALL,
    hint: 'Set "morse.opencode.path", or install OpenCode so it is on PATH.',
  },
];
const NO_ENGINE_MESSAGE = 'No engine is registered as the default, so a draft cannot be probed.';

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
    /** Another engine's failure, so the copy must name that one. */
    private readonly engine?: { kind: string; label: string },
    /** No engine at all: the setup screen offers both installs. */
    private readonly noEngine = false,
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
    const failure = this.noEngine
      ? { message: NO_ENGINE_MESSAGE }
      : this.engine === undefined
        ? { message: MESSAGE, install: INSTALL, hint: HINT }
        : {
            message: `The ${this.engine.label} coding agent was not found.`,
            install:
              this.engine.kind === 'opencode'
                ? OPENCODE_INSTALL
                : `npm install -g @earendil-works/pi-coding-agent`,
            hint: `Install the ${this.engine.label} CLI so that it is on PATH.`,
          };
    const state: SessionViewState = {
      workspace: { cwd: '/work/morse', name: 'morse' },
      ...(this.engine === undefined ? {} : { engine: this.engine.kind }),
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
      busy: false,
      agentReady: false,
      agentStarting: false,
      agentError: failure.message,
      agentFailure: this.noEngine
        ? { code: 'agent-unavailable' }
        : {
            code: 'agent-unavailable',
            install: (failure as { install: string }).install,
            hint: (failure as { hint: string }).hint,
          },
    };
    this.emitMessage({
      type: 'host/ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: capabilities(this.hostKind, this.engine, this.noEngine),
        state,
      },
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

function capabilities(
  hostKind: 'server' | 'vscode',
  engine?: { kind: string; label: string },
  noEngine = false,
): HostCapabilities {
  const scoped = hostKind === 'vscode';
  return {
    hostKind,
    scope: scoped ? 'workspace' : 'global',
    ...(noEngine
      ? { engines: [], engineSetup: SETUP }
      : engine === undefined
        ? {}
        : { engines: [{ ...engine, default: true }] }),
    editorContext: scoped,
    nativeDialogs: scoped,
    insertIntoEditor: scoped,
    revealFile: scoped,
  };
}

async function renderScreen(
  hostKind: 'server' | 'vscode',
  engine?: { kind: string; label: string },
  noEngine = false,
): Promise<{
  host: HTMLElement;
  fixture: ComponentFixture<AgentScreen>;
  transport: MissingAgentTransport;
}> {
  TestBed.resetTestingModule();
  const transport = new MissingAgentTransport(hostKind, false, engine, noEngine);
  await TestBed.configureTestingModule({
    imports: [AgentScreen],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(AgentScreen);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture, transport };
}

async function renderApp(
  withTranscript: boolean,
  noEngine = false,
): Promise<{
  host: HTMLElement;
  transport: MissingAgentTransport;
}> {
  TestBed.resetTestingModule();
  const transport = new MissingAgentTransport('server', withTranscript, undefined, noEngine);
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

    expect(host.textContent).toContain('The pi agent is not installed');
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

  it('names the engine the host reports, not always pi', async () => {
    const { host } = await renderScreen('server', { kind: 'opencode', label: 'OpenCode' });

    expect(host.textContent).toContain('The OpenCode agent is not installed');
    expect(host.textContent).toContain(OPENCODE_INSTALL);
    // The pi setting and environment variable are not this engine's business.
    expect(host.textContent).not.toContain('MORSE_PI_PATH');
    expect(host.textContent).not.toContain('morse.pi.path');
    expect(host.textContent).toContain('morse restart');
  });

  it('offers every install when the host has no engine at all', async () => {
    // Morse is engine-agnostic: with nothing installed there is no engine to
    // blame, so the screen lists both the host knows, each with its own command
    // and the host's own next step — never a hardcoded package name.
    const { host, fixture } = await renderScreen('server', undefined, true);

    expect(host.textContent).toContain('Morse needs a coding agent');
    expect(host.textContent).not.toContain('is not installed');
    const commands = [...host.querySelectorAll('.option .command code')].map((code) =>
      code.textContent?.trim(),
    );
    expect(commands).toEqual([INSTALL, OPENCODE_INSTALL]);
    expect(host.textContent).toContain(SETUP[0].hint);
    expect(host.textContent).toContain(SETUP[1].hint);

    // Copying one row confirms only that row.
    const buttons = [...host.querySelectorAll('.option .command button')] as HTMLButtonElement[];
    buttons[1].click();
    fixture.detectChanges();
    expect(buttons[1].textContent?.trim()).toBe('Copied');
    expect(buttons[0].textContent?.trim()).toBe('Copy');

    // The browser host still gets restart advice rather than a settings dialog.
    expect(host.textContent).toContain('morse restart');
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === 'Open settings'),
    ).toBe(false);
  });

  it('sends a no-engine VS Code window to its settings, with a reload footnote', async () => {
    const { host, fixture } = await renderScreen('vscode', undefined, true);

    expect(host.textContent).toContain('Reload the window');
    expect(host.textContent).not.toContain('morse restart');
    const button = (label: string): HTMLButtonElement =>
      [...host.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === label,
      ) as HTMLButtonElement;
    expect(button('Open settings')).toBeTruthy();
    expect(button('Show log')).toBeTruthy();
    fixture.detectChanges();
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

  it('takes the whole empty panel for the both-installs setup screen', async () => {
    const { host } = await renderApp(false, true);

    expect(host.querySelector('morse-agent-screen')).not.toBeNull();
    expect(host.querySelectorAll('.option .command code')).toHaveLength(2);
  });

  it('keeps the transcript and shrinks the failure to a bar', async () => {
    const { host } = await renderApp(true);

    expect(host.querySelector('morse-agent-screen')).toBeNull();
    expect(host.querySelector('morse-chat-transcript')).not.toBeNull();
    expect(host.querySelector('morse-chat-composer')).not.toBeNull();
    const banner = host.querySelector('.alert');
    expect(banner?.textContent).toContain('Agent unavailable');
    expect(banner?.textContent).toContain('was not found');
  });
});
