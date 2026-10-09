import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientToHostMessage } from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { App } from './app';
import { AttachmentStore } from '../state/attachments';
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
    expect(fixture.nativeElement.querySelector('.toast')?.textContent).toContain('2 files attached');

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
    expect(trigger.querySelector('.provider')?.textContent?.trim()).toBe('mock-cloud');
    expect(trigger.querySelector('.label')?.textContent?.trim()).toBe('Mock Model (pro)');

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
    new KeyboardEvent('keydown', { key, ctrlKey: ctrl, altKey: alt, bubbles: true, cancelable: true }),
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
      new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }),
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

    (host.querySelector(
      'morse-toolbar button[aria-label="Compact the conversation"]',
    ) as HTMLButtonElement).click();
    fixture.detectChanges();

    (host.querySelector(
      'morse-confirm-dialog .actions button:not(.secondary)',
    ) as HTMLButtonElement).click();
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

    (host.querySelector(
      'morse-confirm-dialog .actions button:not(.secondary)',
    ) as HTMLButtonElement).click();
    fixture.detectChanges();

    const compacted = compactions(sent);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      payload: { instructions: 'keep the decisions about the schema' },
    });
  });

  it('cancels quietly: Escape sends nothing and closes the question', async () => {
    const { host, fixture, sent } = await renderApp();

    (host.querySelector(
      'morse-toolbar button[aria-label="Compact the conversation"]',
    ) as HTMLButtonElement).click();
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
    (host.querySelector(
      'morse-confirm-dialog .actions button:not(.secondary)',
    ) as HTMLButtonElement).click();
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
    (host.querySelector(
      'morse-confirm-dialog .actions button:not(.secondary)',
    ) as HTMLButtonElement).click();
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
