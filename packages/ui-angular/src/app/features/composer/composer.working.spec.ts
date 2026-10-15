import { TestBed } from '@angular/core/testing';
import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type SessionActivity,
  type SessionViewState,
} from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { ChatComposer } from './composer';

/**
 * A host whose per-session activity and active-session state the test drives by
 * hand, so a session can start running while another is in front.
 */
class RunningHostTransport extends BaseHostTransport {
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
        state: this.base({}),
      },
    });
  }

  /** Replays the active session's state, the way the host does on a switch. */
  state(patch: Partial<SessionViewState>): void {
    this.emitMessage({ type: 'session/state', payload: this.base(patch) });
  }

  /** Replays the per-session activity list. */
  activity(sessions: SessionActivity[]): void {
    this.emitMessage({ type: 'session/activity', payload: { sessions } });
  }

  private base(patch: Partial<SessionViewState>): SessionViewState {
    return {
      workspace: { cwd: '/work/morse', name: 'morse' },
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
      busy: false,
      agentReady: true,
      agentStarting: false,
      ...patch,
    };
  }

  dispose(): void {
    this.emitStatus('closed');
  }
}

function activity(sessionKey: string, streaming: boolean): SessionActivity {
  return { sessionKey, streaming, busy: false, agentReady: true, agentStarting: false };
}

/** The live "Working …" line, whitespace-normalized, or `''` when hidden. */
function working(host: HTMLElement): string {
  const node = host.querySelector('.working');
  return node === null ? '' : (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function mount(transport: RunningHostTransport): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<ChatComposer>>;
  host: HTMLElement;
  tabs: WorkspaceTabs;
}> {
  await TestBed.configureTestingModule({
    imports: [ChatComposer],
    providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, tabs: TestBed.inject(WorkspaceTabs) };
}

/**
 * One shared composer draws the tab in front, so its run clock must be keyed by
 * session. A single clock leaked: switching between two running sessions kept the
 * first's start time (running stayed true, so the effect never reset), and
 * switching through an idle tab reset it, so returning showed a time that was not
 * the run's.
 */
describe('ChatComposer per-tab Working clock', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('gives each running tab its own elapsed time, not the one it replaced', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const transport = new RunningHostTransport();
    const { fixture, host, tabs } = await mount(transport);

    // t=0: session one starts running.
    transport.activity([activity('s1', true)]);
    transport.state({ sessionId: 's1', streaming: true });
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(1_000);

    // t=1s: session two starts running while one is still going.
    transport.activity([activity('s1', true), activity('s2', true)]);
    await vi.advanceTimersByTimeAsync(2_000);

    // t=3s: front session two. Its own run began at 1s, so it reads 2s — not the
    // 3s the first tab had counted.
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/repo' });
    transport.state({ sessionId: 's2', streaming: true });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(working(host)).toBe('Working 2.0s');

    // And back: session one still reads its own 3s.
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    transport.state({ sessionId: 's1', streaming: true });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(working(host)).toBe('Working 3.0s');
  });

  it('does not restart a tab run after passing through an idle tab', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const transport = new RunningHostTransport();
    const { fixture, host, tabs } = await mount(transport);

    transport.activity([activity('s1', true)]);
    transport.state({ sessionId: 's1', streaming: true });
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(2_000);
    fixture.detectChanges();
    expect(working(host)).toBe('Working 2.0s');

    // Through an idle session: the run in tab one is untouched.
    transport.activity([activity('s1', true), activity('s2', false)]);
    transport.state({ sessionId: 's2', streaming: false });
    tabs.focusSession({ id: 's2', title: 'Two', cwd: '/repo' });
    fixture.detectChanges();
    expect(working(host)).toBe('');

    // Back to tab one: its clock continued; it did not restart at zero.
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    transport.state({ sessionId: 's1', streaming: true });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(1_000);
    fixture.detectChanges();
    expect(working(host)).toBe('Working 3.0s');
  });

  it('starts a session\'s second run at zero, not where the first ended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const transport = new RunningHostTransport();
    const { fixture, host, tabs } = await mount(transport);

    transport.activity([activity('s1', true)]);
    transport.state({ sessionId: 's1', streaming: true });
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/repo' });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(2_000);
    fixture.detectChanges();
    expect(working(host)).toBe('Working 2.0s');

    // The run ends: the clock is released.
    transport.activity([activity('s1', false)]);
    transport.state({ sessionId: 's1', streaming: false });
    fixture.detectChanges();
    expect(working(host)).toBe('');

    // A later run in the same session starts fresh rather than resuming 2s.
    await vi.advanceTimersByTimeAsync(5_000);
    transport.activity([activity('s1', true)]);
    transport.state({ sessionId: 's1', streaming: true });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(1_000);
    fixture.detectChanges();
    expect(working(host)).toBe('Working 1.0s');
  });
});
