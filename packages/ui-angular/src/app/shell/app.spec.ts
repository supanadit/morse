import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientToHostMessage,
  SessionSummary,
  SessionViewState,
  TranscriptItem,
} from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { App } from './app';
import { MorseService } from '../host/morse.service';
import { AttachmentStore } from '../state/attachments';
import { RestoreState } from '../state/restore-state';
import { ShellState } from '../state/shell-state';
import { MORSE_TRANSPORT } from '../host/transport.token';

describe('App', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    // The shell remembers the folded sidebar; tests must not inherit that.
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      // The mock host answers `client/ready` synchronously, so the view is
      // populated without VS Code or the NestJS server.
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
    }).compileComponents();
  });

  it('renders the workspace reported by the host', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    // The status bar carries the workspace's path since the chat header went.
    const path = fixture.nativeElement.querySelector('morse-status-bar .path') as HTMLElement;
    expect(path?.textContent?.trim()).toBe('/mock/workspace');
  });

  it('shows the composer once the agent is ready', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.disabled).toBe(false);
  });

  it('hides a notice toast on its own', () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    TestBed.inject(AttachmentStore).say('info', '2 files attached');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.toast')?.textContent).toContain(
      '2 files attached',
    );

    vi.advanceTimersByTime(4_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.toast')).toBeNull();
  });

  /**
   * The footer must name the provider, not just the model: two providers can
   * expose the same display name, and the picked row must be the one the host
   * ends up selecting.
   */
  /**
   * Row 1 carries the live status (throughput, working, context indicator);
   * row 2 stays pure controls so the dropdowns and send button never move
   * while the numbers tick.
   */
  it('keeps usage on the status row above the model/thinking controls', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('.status-row') as HTMLElement;
    const controls = fixture.nativeElement.querySelector('.controls') as HTMLElement;
    expect(status.querySelector('morse-usage-indicator')).toBeTruthy();
    expect(controls.querySelector('morse-usage-indicator')).toBeNull();
    expect(controls.querySelector('.model-button')).toBeTruthy();
    expect(controls.querySelector('morse-thinking-picker')).toBeTruthy();
    // The live rate sits on the left of row 1; the ring stays on the right.
    expect(status.querySelector('.status-live .throughput')).toBeTruthy();
    expect(status.querySelector('.status-end morse-usage-indicator')).toBeTruthy();
  });

  it('shows the picked model with its provider and re-highlights it on reopen', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.model-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('.row')] as HTMLElement[];
    (rows.find((row) => row.textContent?.includes('Mock Model (pro)')) as HTMLElement).click();
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('.model-button') as HTMLElement;
    expect(trigger.querySelector('.label')?.textContent?.trim()).toBe('Mock Model (pro)');
    // The provider rides the session facts bar under the controls, never inside
    // the trigger: an inline pill would truncate the model name it shows.
    expect(trigger.querySelector('.provider')).toBeNull();
    expect((fixture.nativeElement.querySelector('.facts') as HTMLElement).textContent).toContain(
      'mock-cloud',
    );

    // Reopening highlights the active model, not the first row of the list.
    (trigger as HTMLButtonElement).click();
    fixture.detectChanges();
    const selected = fixture.nativeElement.querySelector(
      '.row[aria-current="true"]',
    ) as HTMLElement | null;
    expect(selected?.textContent).toContain('Mock Model (pro)');
    expect(selected?.classList.contains('active')).toBe(true);
  });

  it('overlays the About dialog when the shell asks for it', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-about-dialog')).toBeNull();

    // The sidebar footer and `/about` both go through this one signal.
    TestBed.inject(ShellState).openAbout();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-about-dialog')).toBeTruthy();
  });

  it('keeps "New session" in the sidebar, not repeated in the chrome', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    // An early header and toolbar carried a second "+" next to the sidebar's
    // button, and VS Code contributes its own `morse.newSession` to the view
    // title bar — so the chrome must not offer a third one.
    const labels = [...fixture.nativeElement.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).not.toContain('New session');

    // The one entry point that both hosts share stays.
    expect(
      fixture.nativeElement.querySelector('morse-session-nav .head button.primary'),
    ).toBeTruthy();
  });

  it('folds the sidebar from the toolbar and brings it back', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const shell = fixture.nativeElement.querySelector('.shell') as HTMLElement;
    expect(shell.classList.contains('collapsed')).toBe(false);

    // The window's own shape is the toolbar's business, not the chat header's.
    const fold = fixture.nativeElement.querySelector(
      'morse-toolbar .collapse',
    ) as HTMLButtonElement;
    fold.click();
    fixture.detectChanges();

    expect(shell.classList.contains('collapsed')).toBe(true);
    // The same button is the way back, and its label says so rather than lying.
    expect(fold.getAttribute('aria-label')).toBe('Show the sidebar');

    fold.click();
    fixture.detectChanges();
    expect(shell.classList.contains('collapsed')).toBe(false);
  });
});

/** The mock host, plus everything the frontend asked it to do. */
class RecordingHost extends MemoryHostTransport {
  readonly sent: ClientToHostMessage[] = [];

  override send(message: ClientToHostMessage): void {
    this.sent.push(message);
    super.send(message);
  }
}

async function renderApp(): Promise<{
  host: HTMLElement;
  fixture: ComponentFixture<App>;
  sent: ClientToHostMessage[];
}> {
  TestBed.resetTestingModule();
  localStorage.clear();
  const transport = new RecordingHost();
  await TestBed.configureTestingModule({
    imports: [App],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture, sent: transport.sent };
}

const compactions = (sent: ClientToHostMessage[]): ClientToHostMessage[] =>
  sent.filter((message) => message.type === 'session/compact');

const stops = (sent: ClientToHostMessage[]): ClientToHostMessage[] =>
  sent.filter((message) => message.type === 'chat/abort');

/** Presses a shortcut on the document, which is where the shell listens. */
function press(key: string, { ctrl = false, alt = false } = {}): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      ctrlKey: ctrl,
      altKey: alt,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * The shortcuts the shell itself owns, through a real App: compaction asks the
 * same question whichever way it was asked for, and the help list is one dialog
 * with three ways in (`?`, the sidebar footer, `/keys`). The keys the sidebar and
 * the composer own are bound and tested next to them.
 */
describe('App · keyboard shortcuts', () => {
  it('asks the compaction question from the keyboard, not straight from the key', async () => {
    const { host, fixture, sent } = await renderApp();

    press('c', { ctrl: true, alt: true });
    fixture.detectChanges();

    expect(host.querySelector('morse-confirm-dialog')).not.toBeNull();
    expect(compactions(sent)).toHaveLength(0);
  });

  it('opens and closes the help list with `?`', async () => {
    const { host, fixture } = await renderApp();
    expect(host.querySelector('morse-shortcuts-dialog')).toBeNull();

    press('?');
    fixture.detectChanges();
    const dialog = host.querySelector('morse-shortcuts-dialog') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Focus the session search');
    // The mock host is a global one with models loaded, so every key this panel
    // offers really has an owner behind it.
    expect(dialog.querySelectorAll('li.unavailable')).toHaveLength(0);

    // The same key closes it again.
    press('?');
    fixture.detectChanges();
    expect(host.querySelector('morse-shortcuts-dialog')).toBeNull();

    // Escape is the other way out, and it leaves nothing behind.
    press('?');
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(host.querySelector('morse-shortcuts-dialog')).toBeNull();
  });

  it('opens the keyboard help from `/keys` in the prompt', async () => {
    const { host, fixture } = await renderApp();

    const prompt = host.querySelector('textarea') as HTMLTextAreaElement;
    prompt.value = '/keys';
    prompt.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(host.querySelector('morse-shortcuts-dialog')).not.toBeNull();
  });

  it('opens the model and the thinking choosers without reaching for the footer', async () => {
    const { host, fixture } = await renderApp();
    expect(host.querySelector('morse-model-picker')).toBeNull();
    expect(host.querySelector('morse-thinking-picker .panel')).toBeNull();

    // Both are modified combinations, so they work with the caret in the prompt.
    const prompt = host.querySelector('textarea') as HTMLTextAreaElement;
    prompt.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    expect(host.querySelector('morse-model-picker')).not.toBeNull();

    press('t', { ctrl: true, alt: true });
    fixture.detectChanges();
    expect(host.querySelector('morse-thinking-picker .panel')).not.toBeNull();
  });
});

/**
 * Compaction is the one action here that spends a model call and rewrites what the
 * agent remembers, so both of its triggers have to stop at a question — a stray
 * click on the header, or a `/compact` typed by accident, must not summarize a
 * conversation on its own.
 */
describe('App · compaction asks first', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the question from the header instead of compacting', async () => {
    const { host, fixture, sent } = await renderApp();

    const compact = host.querySelector(
      'morse-toolbar button[aria-label="Compact the conversation"]',
    ) as HTMLButtonElement;
    compact.click();
    fixture.detectChanges();

    expect(host.querySelector('morse-confirm-dialog')).not.toBeNull();
    expect(compactions(sent)).toHaveLength(0);
  });

  it('asks for the same confirmation after `/compact` in the composer', async () => {
    const { host, fixture, sent } = await renderApp();

    const prompt = host.querySelector('textarea') as HTMLTextAreaElement;
    prompt.value = '/compact';
    prompt.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(host.querySelector('morse-confirm-dialog')).not.toBeNull();
    expect(compactions(sent)).toHaveLength(0);
  });

  it('compacts once, and only when the dialog is confirmed', async () => {
    const { host, fixture, sent } = await renderApp();

    (
      host.querySelector(
        'morse-toolbar button[aria-label="Compact the conversation"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    (
      host.querySelector(
        'morse-confirm-dialog .actions button:not(.secondary)',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(compactions(sent)).toHaveLength(1);
    expect(host.querySelector('morse-confirm-dialog')).toBeNull();
  });

  it('gates `/compact <instructions>` too, and hands the words to pi', async () => {
    const { host, fixture, sent } = await renderApp();

    const prompt = host.querySelector('textarea') as HTMLTextAreaElement;
    prompt.value = '/compact keep the decisions about the schema';
    prompt.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    // The command is destructive wherever it came from: nothing is sent yet, and the
    // question repeats the instructions so a typo can still be caught.
    expect(compactions(sent)).toHaveLength(0);
    expect(host.querySelector('morse-confirm-dialog .body')?.textContent).toContain(
      'keep the decisions about the schema',
    );

    (
      host.querySelector(
        'morse-confirm-dialog .actions button:not(.secondary)',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    const compacted = compactions(sent);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      payload: { instructions: 'keep the decisions about the schema' },
    });
  });

  it('keeps the question a plain yes/no while the conversation is quiet', async () => {
    const { host, fixture } = await renderApp();

    (
      host.querySelector(
        'morse-toolbar button[aria-label="Compact the conversation"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    // Nothing is running, so there is nothing to wait for: one honest way to say
    // yes, not two.
    const labels = [...host.querySelectorAll('morse-confirm-dialog .actions button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toEqual(['Cancel', 'Compact context']);
  });

  it('offers Schedule Compact while a run is in flight, and hands the host a schedule', async () => {
    const { host, fixture, sent } = await renderApp();

    // The run the reader does not want aborted — the follow-ups queued behind it
    // are exactly what a compaction now would take with it.
    const prompt = host.querySelector('textarea') as HTMLTextAreaElement;
    prompt.value = 'go on';
    prompt.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    (
      host.querySelector(
        'morse-toolbar button[aria-label="Compact the conversation"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    const schedule = [...host.querySelectorAll('morse-confirm-dialog .actions button')].find(
      (button) => button.textContent?.trim() === 'Schedule Compact',
    ) as HTMLButtonElement;
    schedule.click();
    fixture.detectChanges();

    // One message goes out, and it is the schedule rather than the compaction:
    // the run keeps going and the host fires the compact at the settle.
    const scheduled = compactions(sent);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ payload: { schedule: true } });
    expect(host.querySelector('morse-confirm-dialog')).toBeNull();
  });

  it('cancels quietly: Escape sends nothing and closes the question', async () => {
    const { host, fixture, sent } = await renderApp();

    (
      host.querySelector(
        'morse-toolbar button[aria-label="Compact the conversation"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(compactions(sent)).toHaveLength(0);
    expect(host.querySelector('morse-confirm-dialog')).toBeNull();
  });

  it('asks before stopping a run, and the answer is the only way the abort is sent', async () => {
    const { host, fixture, sent } = await renderApp();

    // The Stop button sits beside Steer and Follow up, so a stray press is one slip
    // away. It only asks: nothing reaches the host until the question is answered.
    TestBed.inject(ShellState).requestStop();
    fixture.detectChanges();

    expect(host.querySelector('morse-confirm-dialog')?.textContent).toContain('Stop the run?');
    TestBed.inject(ShellState).closeStopPrompt();
    fixture.detectChanges();
    expect(stops(sent)).toHaveLength(0);
  });

  it('aborts once the stop question is confirmed, and Escape only closes it', async () => {
    vi.useFakeTimers();
    const { host, fixture, sent } = await renderApp();

    // The question only exists while a run does, so start a real one: the answer
    // landing before the confirm is exactly the case the guard below refuses.
    const prompt = host.querySelector('textarea') as HTMLTextAreaElement;
    prompt.value = 'do the thing';
    prompt.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();

    TestBed.inject(ShellState).requestStop();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    // Escape is the safe direction: it takes the question down and stops nothing.
    expect(host.querySelector('morse-confirm-dialog')).toBeNull();
    expect(stops(sent)).toHaveLength(0);

    TestBed.inject(ShellState).requestStop();
    fixture.detectChanges();
    (
      host.querySelector(
        'morse-confirm-dialog .actions button:not(.secondary)',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(stops(sent)).toHaveLength(1);
    expect(host.querySelector('morse-confirm-dialog')).toBeNull();
  });

  it('retracts the stop question when the run it guards finishes first', async () => {
    vi.useFakeTimers();
    const { host, fixture, sent } = await renderApp();

    // A real run: the prompt starts the mock host streaming, which is what makes
    // Stop (and therefore the question) available in the first place.
    const prompt = host.querySelector('textarea') as HTMLTextAreaElement;
    prompt.value = 'do the thing';
    prompt.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();

    TestBed.inject(ShellState).requestStop();
    fixture.detectChanges();
    expect(host.querySelector('morse-confirm-dialog')).not.toBeNull();

    // The answer lands before the reader decides. The question was only ever about
    // the run in flight, so it takes itself down — no stale gate on an idle session.
    await vi.advanceTimersByTimeAsync(10_000);
    fixture.detectChanges();
    expect(host.querySelector('morse-confirm-dialog')).toBeNull();
    expect(stops(sent)).toHaveLength(0);
  });

  it('drops a yes that arrives after the run already ended', async () => {
    const { host, fixture, sent } = await renderApp();

    // The dialog and the run settling can land on the same tick: the question is up
    // while the run has already finished. Confirming must not reach the host — an
    // abort here would be a no-op at best, and could cut a run started since.
    TestBed.inject(ShellState).requestStop();
    fixture.detectChanges();
    (
      host.querySelector(
        'morse-confirm-dialog .actions button:not(.secondary)',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(stops(sent)).toHaveLength(0);
  });

  it('takes down only the dialog on top, so one Escape cannot close two', async () => {
    const { host, fixture } = await renderApp();

    // Two dialogs at once, the way the app really gets them: the palette, and the
    // compaction question asked over it. Each one registers while it is up, and the
    // press belongs to the last of them.
    press('k', { ctrl: true, alt: true });
    fixture.detectChanges();
    expect(host.querySelector('morse-command-palette')).not.toBeNull();

    TestBed.inject(ShellState).requestCompact('keep the schema');
    fixture.detectChanges();
    expect(host.querySelector('morse-confirm-dialog')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    // The question went; the palette that asked it did not.
    expect(host.querySelector('morse-confirm-dialog')).toBeNull();
    expect(host.querySelector('morse-command-palette')).not.toBeNull();
  });
});

/**
 * The restore's safety net. A saved session travels back over several round
 * trips (layout read, activation, transcript replay), and a panel that looks
 * empty in the meantime reads as a brand-new session — a prompt typed into it
 * would race the restore. While the flag is up the panel shows a loading screen
 * and the composer is not mounted at all.
 */
describe('App · restoring screen', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function mount() {
    const fixture = TestBed.createComponent(App);
    const restore = TestBed.inject(RestoreState);
    const transport = TestBed.inject(MORSE_TRANSPORT) as MemoryHostTransport;
    return { fixture, restore, transport, element: fixture.nativeElement };
  }

  it('covers the panel and keeps the composer unmounted while restoring', () => {
    const { fixture, restore, element } = mount();
    restore.begin();
    fixture.detectChanges();

    expect(element.querySelector('.restoring')).toBeTruthy();
    expect(element.querySelector('morse-chat-composer')).toBeNull();
  });

  it('hands the panel back once the restore ends', () => {
    const { fixture, restore, element } = mount();
    restore.begin();
    fixture.detectChanges();
    restore.end();
    fixture.detectChanges();

    expect(element.querySelector('.restoring')).toBeNull();
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
  });

  it('swallows a prompt typed into the race window', () => {
    const { fixture, restore, transport } = mount();
    // The composer mounts once the restore is over; the flag flips again before
    // the view catches up (the exact shape of the race), and a send must go
    // nowhere.
    restore.end();
    fixture.detectChanges();
    const composer = fixture.debugElement.query((node) => node.name === 'morse-chat-composer');
    expect(composer).toBeTruthy();

    restore.begin();
    const sendSpy = vi.spyOn(transport, 'send');
    (composer!.componentInstance as { sendWith: (mode: string) => void }).sendWith('new');
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

/**
 * A spawned session (a subagent run) is watched, not prompted: the panel swaps
 * to its transcript with a bar that names the state and offers the way back,
 * and the composer dock never mounts. A fork child never carries the flag and
 * stays a normal session with its composer.
 */
describe('App · watching a subagent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  /**
   * The subagent feature reads four things off `MorseService`: the catalog, the
   * two flags derived from it, and which session is in front. Everything else
   * keeps running on the real service and its mock host. `defineProperty` wins
   * over a fake because the service is otherwise a web of computeds over one
   * private view — stubbing the whole class drags every consumer along.
   */
  function watchSubagent(
    fixture: ComponentFixture<App>,
    readouts: {
      engine?: string;
      model?: { name: string; provider: string; id: string };
      mode?: string;
      thinkingLevel?: string;
    } = {},
  ): void {
    const morse = TestBed.inject(MorseService) as unknown as Record<string, unknown>;
    const state = signal<SessionViewState>({
      workspace: { cwd: '/work/morse', name: 'morse' },
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
      busy: false,
      agentReady: true,
      agentStarting: false,
      sessionId: 'kid',
    } as SessionViewState);
    Object.defineProperty(morse, 'state', { value: state });
    Object.defineProperty(morse, 'sessions', {
      value: signal<SessionSummary[]>([
        {
          id: 'parent',
          title: 'The parent conversation',
          cwd: '/work/morse',
          updatedAt: 1,
          messageCount: 2,
        },
        {
          id: 'kid',
          title: 'explore',
          cwd: '/work/morse',
          updatedAt: 2,
          messageCount: 1,
          parentId: 'parent',
          subagent: true,
        },
      ]),
    });
    Object.defineProperty(morse, 'activeIsSubagent', { value: signal(true) });
    Object.defineProperty(morse, 'parentOfActive', {
      value: signal({
        id: 'parent',
        title: 'The parent conversation',
        cwd: '/work/morse',
        updatedAt: 1,
        messageCount: 2,
      }),
    });
    Object.defineProperty(morse, 'activateSession', {
      value: (id: string) =>
        state.update((value: SessionViewState) => ({ ...value, sessionId: id })),
    });
    // The bar reads the child's own state; overrides must land before the
    // first render, when the bindings are first evaluated.
    if (readouts.engine !== undefined) {
      Object.defineProperty(morse, 'engine', { value: () => readouts.engine });
    }
    if (readouts.model !== undefined) {
      Object.defineProperty(morse, 'model', { value: () => readouts.model });
    }
    if (readouts.mode !== undefined) {
      Object.defineProperty(morse, 'mode', { value: () => readouts.mode });
    }
    if (readouts.thinkingLevel !== undefined) {
      Object.defineProperty(morse, 'thinkingLevel', { value: () => readouts.thinkingLevel });
    }
    fixture.detectChanges();
  }

  it('shows what the child runs with in the subagent bar', () => {
    const fixture = TestBed.createComponent(App);
    // A subagent can be configured with a model of its own (OpenCode names one
    // per agent in its settings), so the bar reads the child's state, not the
    // parent's pickers.
    watchSubagent(fixture, {
      engine: 'opencode',
      model: { provider: 'deepseek', id: 'v4.1', name: 'DeepSeek V4.1' },
      mode: 'plan',
      thinkingLevel: 'low',
    });

    const bar = (fixture.nativeElement as HTMLElement).querySelector('.subagent-bar');
    const chips = [...(bar?.querySelectorAll('.chip') ?? [])].map((chip) => chip.textContent);
    expect(chips).toContain('opencode');
    expect(chips.some((text) => text?.includes('DeepSeek V4.1'))).toBe(true);
    expect(chips).toContain('plan');
    expect(chips).toContain('low');
  });

  it('hides the composer and offers the way back while watching a subagent', () => {
    const fixture = TestBed.createComponent(App);
    watchSubagent(fixture);

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.subagent-bar')).toBeTruthy();
    expect(element.querySelector('.subagent-bar .back')?.textContent).toContain(
      'The parent conversation',
    );
    expect(element.querySelector('morse-chat-composer')).toBeNull();
  });

  it('returns to the parent when the back affordance is used', () => {
    const fixture = TestBed.createComponent(App);
    watchSubagent(fixture);

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.subagent-bar .back')
      ?.click();
    fixture.detectChanges();

    const morse = TestBed.inject(MorseService) as unknown as { state(): { sessionId?: string } };
    expect(morse.state().sessionId).toBe('parent');
  });

  it('re-reads the conversation when the refresh affordance is used', () => {
    const fixture = TestBed.createComponent(App);
    watchSubagent(fixture);

    let refreshed = 0;
    const morse = TestBed.inject(MorseService);
    Object.defineProperty(morse, 'refreshSession', { value: () => (refreshed += 1) });
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.subagent-bar .refresh')
      ?.click();

    expect(refreshed).toBe(1);
  });
});
